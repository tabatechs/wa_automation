/**
 * Captura reações SEM licença paga.
 *
 * Na v4 o listener nativo `onReaction` é gated por licença `insiders`. Mas o
 * objeto Message já carrega `reactions[]`, com `senders[]` contendo
 * `senderUserJid`, `reactionText` e `timestamp` — e `getAllMessagesInChat` é
 * livre. Então relemos periodicamente as mensagens da janela recente e comparamos
 * com o estado anterior para derivar reaction_added / reaction_removed.
 *
 * Custo: UMA chamada por grupo por ciclo, não uma por mensagem.
 *
 * Limitação conhecida: getAllMessagesInChat só enxerga o que está carregado no
 * store do WhatsApp Web. Reações em mensagens antigas o bastante para sair da
 * janela deixam de ser detectadas.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Message } from '@open-wa/wa-automate';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, ReactionPayload } from '../types';
import { waTimestampToIso } from '../util/phone';
import { createLogger } from '../util/logger';
import { localIso } from '../util/time';
import type { Collector, CollectorContext } from './Collector';
import type { MessageWindow } from './messageWindow';

const log = createLogger('collector:reactions');
/**
 * v2: cada mensagem passou a guardar o próprio timestamp, para que a poda do
 * estado seja por IDADE. Na v1 a poda descartava tudo que não estivesse na
 * MessageWindow — e como a janela é só memória, ela nasce vazia a cada
 * restart, o que apagava o registro de reações já emitidas e fazia o backfill
 * reemiti-las. Estado durável não pode depender de estrutura volátil.
 */
const STATE_VERSION = 2;

/** Chave de uma reação individual: quem reagiu + com quê. */
type ReactionKey = `${string}|${string}`;

interface MessageReactions {
  keys: Set<ReactionKey>;
  /** Epoch ms da mensagem, usado só para expirar o registro. */
  at: number;
}

interface PersistedState {
  version: number;
  /** groupId -> messageId -> { k: chaves já emitidas, at: epoch ms } */
  groups: Record<string, Record<string, { k: string[]; at: number }>>;
}

interface ReactionSenderLike {
  senderUserJid?: string;
  reactionText?: string;
  timestamp?: number;
  t?: number;
}

export class ReactionsCollector implements Collector {
  readonly name = 'reactions';

  /** groupId -> messageId -> reações já emitidas. */
  private readonly state = new Map<string, Map<string, MessageReactions>>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly statePath: string;

  constructor(
    private readonly window: MessageWindow,
    stateDir: string,
  ) {
    this.statePath = path.join(stateDir, 'reactions.json');
    this.load();
  }

  /**
   * Fixa a linha de base de uma mensagem entrando na janela como "nenhuma
   * reação emitida ainda". Chamado pela MessageWindow via callback.
   *
   * Só age se a mensagem for desconhecida: se o estado já a conhece — inclusive
   * vindo do disco após um restart — a linha de base preservada é o que impede
   * reemitir reações que já foram registradas.
   */
  noteLiveMessage(groupId: string, messageId: string, at: number): void {
    const group = this.state.get(groupId) ?? new Map<string, MessageReactions>();
    if (!group.has(messageId)) group.set(messageId, { keys: new Set(), at });
    this.state.set(groupId, group);
  }

  async start(ctx: CollectorContext): Promise<void> {
    // Primeira varredura imediata para semear o estado das mensagens que já
    // estavam no histórico antes de o monitor subir.
    await this.poll(ctx);

    this.timer = setInterval(() => {
      void this.poll(ctx);
    }, ctx.config.reactionPollMs);
    // Não segura o event loop no shutdown.
    this.timer.unref?.();

    log.info('polling de reações ativo', { intervalMs: ctx.config.reactionPollMs });
  }

  private async poll(ctx: CollectorContext): Promise<void> {
    if (this.running || this.stopped) return; // evita ciclos sobrepostos
    this.running = true;
    try {
      for (const group of ctx.config.groups) {
        await this.pollGroup(ctx, group.id);
      }
      this.pruneByAge(ctx);
      this.persist();
    } catch (error) {
      log.error('ciclo de polling falhou', error);
    } finally {
      this.running = false;
    }
  }

  private async pollGroup(ctx: CollectorContext, groupId: string): Promise<void> {
    const tracked = this.window.ids(groupId);
    if (tracked.size === 0) return;

    let messages: Message[];
    try {
      messages = await ctx.client.getAllMessagesInChat(
        groupId as Parameters<typeof ctx.client.getAllMessagesInChat>[0],
        true,
        false,
      );
    } catch (error) {
      log.warn('getAllMessagesInChat falhou', { groupId, error: String(error) });
      return;
    }

    const groupState = this.state.get(groupId) ?? new Map<string, MessageReactions>();

    for (const message of messages ?? []) {
      const messageId = String(message?.id ?? '');
      if (!messageId || !tracked.has(messageId)) continue;

      const current = extractReactions(message);
      const entry = groupState.get(messageId);

      if (entry === undefined) {
        // Mensagem que nunca passou pela janela (nem ao vivo, nem pelo
        // backfill). Semeia em silêncio: não sabemos o que já foi registrado
        // antes, e emitir aqui despejaria reações antigas como se fossem novas.
        groupState.set(messageId, { keys: new Set(current.keys()), at: messageTime(message) });
        continue;
      }

      const previous = entry.keys;
      for (const [key, detail] of current) {
        if (!previous.has(key)) {
          await this.emitReaction(ctx, groupId, messageId, detail, 'reaction_added');
        }
      }
      for (const key of previous) {
        if (!current.has(key)) {
          const [senderId = '', emoji = ''] = key.split('|');
          await this.emitReaction(
            ctx,
            groupId,
            messageId,
            { senderId, emoji, reactedAt: null },
            'reaction_removed',
          );
        }
      }

      groupState.set(messageId, { keys: new Set(current.keys()), at: entry.at });
    }

    this.state.set(groupId, groupState);
  }

  /**
   * Expira registros antigos para o estado não crescer sem fim.
   *
   * A retenção precisa cobrir a janela do backfill: enquanto o backfill puder
   * retrazer uma mensagem, o registro de quais reações dela já foram emitidas
   * tem de continuar existindo — senão elas seriam emitidas de novo.
   */
  private pruneByAge(ctx: CollectorContext): void {
    const retentionMs = Math.max(
      ctx.config.backfillDays * 24 * 60 * 60 * 1000,
      ctx.config.reactionWindowMs,
    );
    const cutoff = Date.now() - retentionMs;

    let removed = 0;
    for (const [groupId, groupState] of this.state) {
      for (const [messageId, entry] of groupState) {
        // at === 0 significa timestamp desconhecido; nesse caso não expira,
        // porque não dá para provar que é antigo o bastante.
        if (entry.at > 0 && entry.at < cutoff) {
          groupState.delete(messageId);
          removed += 1;
        }
      }
      if (groupState.size === 0) this.state.delete(groupId);
    }
    if (removed) log.debug('registros de reação expirados', { removed });
  }

  private async emitReaction(
    ctx: CollectorContext,
    groupId: string,
    messageId: string,
    detail: ReactionDetail,
    type: 'reaction_added' | 'reaction_removed',
  ): Promise<void> {
    const payload: ReactionPayload = {
      targetMessageId: messageId,
      emoji: detail.emoji,
      reactedAt: detail.reactedAt,
    };

    const event: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type,
      capturedAt: localIso(),
      group: { id: groupId, name: await ctx.groupName(groupId) },
      actor: await ctx.roster.resolve(detail.senderId),
      payload,
    } as CapturedEvent;

    await ctx.emit(event);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
  }

  // --- persistência --------------------------------------------------------

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as
        | PersistedState
        | { version: 1; groups: Record<string, Record<string, string[]>> };
      if (!raw?.groups) return;

      // O v1 não guardava timestamp por mensagem. Migra preservando as chaves
      // já emitidas — é justamente esse registro que evita reemissão — e marca
      // `at: 0`, que a poda por idade trata como "não expirar".
      const isV1 = raw.version === 1;

      for (const [groupId, messages] of Object.entries(raw.groups)) {
        const group = new Map<string, MessageReactions>();
        for (const [messageId, value] of Object.entries(messages)) {
          if (isV1) {
            group.set(messageId, { keys: new Set(value as ReactionKey[]), at: 0 });
          } else {
            const entry = value as { k: string[]; at: number };
            group.set(messageId, {
              keys: new Set((entry.k ?? []) as ReactionKey[]),
              at: typeof entry.at === 'number' ? entry.at : 0,
            });
          }
        }
        this.state.set(groupId, group);
      }
      log.info('estado de reações restaurado', {
        groups: this.state.size,
        migradoDoV1: isV1,
      });
    } catch {
      // Primeira execução ou arquivo corrompido: começa do zero. As mensagens
      // do histórico serão semeadas em silêncio na primeira varredura.
    }
  }

  private persist(): void {
    const payload: PersistedState = { version: STATE_VERSION, groups: {} };
    for (const [groupId, messages] of this.state) {
      const serialized: Record<string, { k: string[]; at: number }> = {};
      for (const [messageId, entry] of messages) {
        serialized[messageId] = { k: [...entry.keys], at: entry.at };
      }
      payload.groups[groupId] = serialized;
    }

    try {
      mkdirSync(path.dirname(this.statePath), { recursive: true });
      // tmp + rename: um crash no meio da escrita não deixa o estado corrompido.
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, this.statePath);
    } catch (error) {
      log.warn('não foi possível persistir o estado de reações', error);
    }
  }
}

interface ReactionDetail {
  senderId: string;
  emoji: string;
  reactedAt: string | null;
}

/** Epoch ms da mensagem, ou 0 quando o timestamp não é utilizável. */
function messageTime(message: Message): number {
  const raw = message?.timestamp ?? (message as { t?: number })?.t;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e11 ? raw : raw * 1000;
}

/** Achata Message.reactions[].senders[] num mapa chave -> detalhe. */
function extractReactions(message: Message): Map<ReactionKey, ReactionDetail> {
  const result = new Map<ReactionKey, ReactionDetail>();
  const groups = (message as { reactions?: Array<{ senders?: ReactionSenderLike[] }> }).reactions;
  if (!Array.isArray(groups)) return result;

  for (const group of groups) {
    for (const sender of group?.senders ?? []) {
      const senderId = sender?.senderUserJid ? String(sender.senderUserJid) : '';
      const emoji = typeof sender?.reactionText === 'string' ? sender.reactionText : '';
      // reactionText vazio é uma reação removida que o WhatsApp ainda lista.
      if (!senderId || !emoji) continue;
      result.set(`${senderId}|${emoji}`, {
        senderId,
        emoji,
        reactedAt: waTimestampToIso(sender.timestamp ?? sender.t),
      });
    }
  }
  return result;
}
