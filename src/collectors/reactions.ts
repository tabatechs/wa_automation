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
import type { Collector, CollectorContext } from './Collector';
import type { MessageWindow } from './messageWindow';

const log = createLogger('collector:reactions');
const STATE_VERSION = 1;

/** Chave de uma reação individual: quem reagiu + com quê. */
type ReactionKey = `${string}|${string}`;

interface PersistedState {
  version: number;
  /** groupId -> messageId -> lista de ReactionKey */
  groups: Record<string, Record<string, string[]>>;
}

interface ReactionSenderLike {
  senderUserJid?: string;
  reactionText?: string;
  timestamp?: number;
  t?: number;
}

export class ReactionsCollector implements Collector {
  readonly name = 'reactions';

  /** groupId -> messageId -> conjunto de reações conhecidas. */
  private readonly state = new Map<string, Map<string, Set<ReactionKey>>>();
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
   * Fixa a linha de base de uma mensagem vista ao vivo como "sem reações".
   * Chamado pela MessageWindow via callback.
   */
  noteLiveMessage(groupId: string, messageId: string): void {
    const group = this.state.get(groupId) ?? new Map<string, Set<ReactionKey>>();
    if (!group.has(messageId)) group.set(messageId, new Set());
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

    const groupState = this.state.get(groupId) ?? new Map<string, Set<ReactionKey>>();

    for (const message of messages ?? []) {
      const messageId = String(message?.id ?? '');
      if (!messageId || !tracked.has(messageId)) continue;

      const current = extractReactions(message);
      const previous = groupState.get(messageId);

      if (previous === undefined) {
        // Nunca diffamos esta mensagem (veio do histórico). Semeia em silêncio:
        // emitir aqui despejaria reações antigas como se fossem novas.
        groupState.set(messageId, new Set(current.keys()));
        continue;
      }

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

      groupState.set(messageId, new Set(current.keys()));
    }

    // Descarta mensagens que saíram da janela para o estado não crescer sem fim.
    for (const messageId of [...groupState.keys()]) {
      if (!tracked.has(messageId)) groupState.delete(messageId);
    }

    this.state.set(groupId, groupState);
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
      capturedAt: new Date().toISOString(),
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
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState;
      if (raw?.version !== STATE_VERSION || !raw.groups) return;
      for (const [groupId, messages] of Object.entries(raw.groups)) {
        const group = new Map<string, Set<ReactionKey>>();
        for (const [messageId, keys] of Object.entries(messages)) {
          group.set(messageId, new Set(keys as ReactionKey[]));
        }
        this.state.set(groupId, group);
      }
      log.info('estado de reações restaurado', { groups: this.state.size });
    } catch {
      // Primeira execução ou arquivo corrompido: começa do zero. As mensagens
      // do histórico serão semeadas em silêncio na primeira varredura.
    }
  }

  private persist(): void {
    const payload: PersistedState = { version: STATE_VERSION, groups: {} };
    for (const [groupId, messages] of this.state) {
      const serialized: Record<string, string[]> = {};
      for (const [messageId, keys] of messages) serialized[messageId] = [...keys];
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
