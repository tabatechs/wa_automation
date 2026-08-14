/**
 * Captura quem abriu as mensagens enviadas pela PRÓPRIA conta.
 *
 * ## O escopo, que não é escolha nossa
 *
 * O WhatsApp só entrega confirmação de leitura a quem enviou. Não existe forma
 * de saber quem leu a mensagem de outra pessoa — nem pela API, nem pelo store,
 * nem no aplicativo. Então isto vale exclusivamente para mensagens `fromMe`:
 * as que você escreve à mão pelo celular nos grupos monitorados. O monitor
 * continua sem enviar nada; ele só lê o recibo do que você mandou.
 *
 * Em grupo a confirmação de leitura é sempre enviada, independentemente da
 * configuração de privacidade de quem lê — ao contrário da conversa individual.
 * É o que torna este sinal utilizável para medir engajamento.
 *
 * ## Como funciona
 *
 * Mesmo desenho do coletor de reações: polling com diff. Cada mensagem própria
 * que passa pela `MessageWindow` entra numa lista de vigiadas; a cada ciclo o
 * `MessageInfoReader` é consultado e quem aparecer como leitor novo vira um
 * evento `message_read`. O estado de quem já foi emitido é persistido em disco
 * — sem isso, um restart reemitiria toda a lista de leitores.
 *
 * Uma mensagem sai da vigilância quando todo mundo já leu (`readRemaining: 0`)
 * ou quando fica velha demais. O custo é uma consulta por mensagem vigiada por
 * ciclo, daí o teto por ciclo: um dia de mensagens próprias não pode virar
 * centenas de consultas de uma vez.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, MessageReadPayload } from '../types';
import { MessageInfoReader, type MessageInfoSource } from '../enrich/messageInfo';
import { createLogger } from '../util/logger';
import type { Collector, CollectorContext } from './Collector';

const log = createLogger('collector:read-receipts');

const STATE_VERSION = 1;

interface WatchedMessage {
  /** Ids de quem já teve leitura emitida. */
  readers: Set<string>;
  /** Epoch ms da mensagem. */
  at: number;
  /** true quando todo o grupo já leu — não há mais o que perguntar. */
  done: boolean;
}

interface PersistedState {
  version: number;
  /** groupId -> messageId -> { r: leitores emitidos, at: epoch ms, d: concluída } */
  groups: Record<string, Record<string, { r: string[]; at: number; d?: boolean }>>;
}

export class ReadReceiptsCollector implements Collector {
  readonly name = 'read-receipts';

  /** groupId -> messageId -> leitores já emitidos. */
  private readonly state = new Map<string, Map<string, WatchedMessage>>();
  private reader: MessageInfoSource | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly statePath: string;

  constructor(
    stateDir: string,
    /** Injetável para o teste rodar sem sessão do WhatsApp. */
    private readonly makeReader: (ctx: CollectorContext) => MessageInfoSource = (ctx) =>
      new MessageInfoReader(ctx.client),
  ) {
    this.statePath = path.join(stateDir, 'read-receipts.json');
    this.load();
  }

  /**
   * Põe uma mensagem própria sob vigilância. Chamado pela MessageWindow.
   *
   * Só age se a mensagem for desconhecida: o registro vindo do disco é o que
   * impede reemitir, depois de um restart, leituras que já foram gravadas.
   */
  noteOwnMessage(groupId: string, messageId: string, at: number): void {
    const group = this.state.get(groupId) ?? new Map<string, WatchedMessage>();
    if (!group.has(messageId)) {
      group.set(messageId, { readers: new Set(), at, done: false });
    }
    this.state.set(groupId, group);
  }

  async start(ctx: CollectorContext): Promise<void> {
    if (!ctx.config.readReceiptsEnabled) {
      log.info('confirmação de leitura desligada por configuração');
      return;
    }

    this.reader = this.makeReader(ctx);
    await this.poll(ctx);

    this.timer = setInterval(() => {
      void this.poll(ctx);
    }, ctx.config.readReceiptPollMs);
    this.timer.unref?.();

    log.info('polling de confirmações de leitura ativo', {
      intervalMs: ctx.config.readReceiptPollMs,
      tetoPorCiclo: ctx.config.readReceiptMaxPerCycle,
    });
  }

  private async poll(ctx: CollectorContext): Promise<void> {
    if (this.running || this.stopped || !this.reader) return;
    this.running = true;
    try {
      const selfId = normalizeParticipant((await ctx.roster.resolveSelf())?.id ?? '');
      let budget = ctx.config.readReceiptMaxPerCycle;

      for (const group of ctx.config.groups) {
        if (budget <= 0) break;
        budget -= await this.pollGroup(ctx, group.id, selfId, budget);
      }

      this.pruneByAge(ctx);
      this.persist();

      // Nenhuma rota respondeu em nenhuma tentativa: insistir a cada ciclo só
      // gastaria consulta. Desliga e diz o que fazer para investigar.
      if (!this.reader.available) {
        log.warn(
          'nenhuma via de confirmação de leitura funcionou nesta sessão; ' +
            'polling desligado. Rode `npm run probe-reads` para o diagnóstico.',
        );
        await this.stop();
      }
    } catch (error) {
      log.error('ciclo de polling falhou', error);
    } finally {
      this.running = false;
    }
  }

  /** Devolve quantas consultas foram gastas. */
  private async pollGroup(
    ctx: CollectorContext,
    groupId: string,
    selfId: string,
    budget: number,
  ): Promise<number> {
    const groupState = this.state.get(groupId);
    if (!groupState || groupState.size === 0) return 0;

    const cutoff = Date.now() - ctx.config.readReceiptWindowMs;
    // As mais recentes primeiro: são as que ainda estão ganhando leitores.
    const pending = [...groupState.entries()]
      .filter(([, entry]) => !entry.done && entry.at >= cutoff)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, budget);

    let spent = 0;
    for (const [messageId, entry] of pending) {
      if (this.stopped || !this.reader) break;
      spent += 1;

      const info = await this.reader.read(messageId);
      if (!info) {
        if (!this.reader.available) break;
        continue;
      }

      for (const receipt of info.readers) {
        const readerId = normalizeParticipant(receipt.contactId);
        // A própria conta aparece na lista em alguns builds; não é leitura de
        // ninguém e viraria uma pessoa fantasma nas métricas.
        if (!readerId || readerId === selfId) continue;
        if (entry.readers.has(readerId)) continue;

        entry.readers.add(readerId);
        await this.emitRead(ctx, groupId, messageId, readerId, receipt.readAt, info.source);
      }

      // Todo mundo leu: nada mais vai mudar nesta mensagem.
      if (info.readRemaining === 0) entry.done = true;
    }

    return spent;
  }

  private async emitRead(
    ctx: CollectorContext,
    groupId: string,
    messageId: string,
    readerId: string,
    readAt: string | null,
    source: MessageReadPayload['source'],
  ): Promise<void> {
    const payload: MessageReadPayload = {
      targetMessageId: messageId,
      readAt,
      source,
    };

    const event: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type: 'message_read',
      capturedAt: new Date().toISOString(),
      group: { id: groupId, name: await ctx.groupName(groupId) },
      actor: await ctx.roster.resolve(readerId),
      payload,
    };

    await ctx.emit(event);
  }

  /**
   * Expira registros antigos. A retenção cobre a janela do backfill pelo mesmo
   * motivo das reações: enquanto o backfill puder retrazer a mensagem, o
   * registro de quem já foi emitido precisa continuar existindo.
   */
  private pruneByAge(ctx: CollectorContext): void {
    const retentionMs = Math.max(
      ctx.config.backfillDays * 24 * 60 * 60 * 1000,
      ctx.config.readReceiptWindowMs,
    );
    const cutoff = Date.now() - retentionMs;

    let removed = 0;
    for (const [groupId, groupState] of this.state) {
      for (const [messageId, entry] of groupState) {
        // at === 0 é timestamp desconhecido: não dá para provar que é antigo.
        if (entry.at > 0 && entry.at < cutoff) {
          groupState.delete(messageId);
          removed += 1;
        }
      }
      if (groupState.size === 0) this.state.delete(groupId);
    }
    if (removed) log.debug('registros de leitura expirados', { removed });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
  }

  // --- persistência ---------------------------------------------------------

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState;
      if (!raw?.groups) return;

      for (const [groupId, messages] of Object.entries(raw.groups)) {
        const group = new Map<string, WatchedMessage>();
        for (const [messageId, entry] of Object.entries(messages)) {
          group.set(messageId, {
            readers: new Set(entry.r ?? []),
            at: typeof entry.at === 'number' ? entry.at : 0,
            done: entry.d === true,
          });
        }
        this.state.set(groupId, group);
      }
      log.info('estado de leituras restaurado', { groups: this.state.size });
    } catch {
      // Primeira execução ou arquivo corrompido: começa do zero.
    }
  }

  private persist(): void {
    const payload: PersistedState = { version: STATE_VERSION, groups: {} };
    for (const [groupId, messages] of this.state) {
      const serialized: Record<string, { r: string[]; at: number; d?: boolean }> = {};
      for (const [messageId, entry] of messages) {
        serialized[messageId] = {
          r: [...entry.readers],
          at: entry.at,
          ...(entry.done ? { d: true } : {}),
        };
      }
      payload.groups[groupId] = serialized;
    }

    try {
      mkdirSync(path.dirname(this.statePath), { recursive: true });
      // tmp + rename: um crash no meio da escrita não corrompe o estado.
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, this.statePath);
    } catch (error) {
      log.warn('não foi possível persistir o estado de leituras', error);
    }
  }
}

/**
 * Tira o sufixo de dispositivo de um id (`5511...:12@c.us`, `1993...:71@lid`).
 *
 * A confirmação de leitura vem por dispositivo: a mesma pessoa com celular e
 * WhatsApp Web abertos apareceria duas vezes e contaria duas leituras.
 */
export function normalizeParticipant(id: string): string {
  if (!id) return '';
  const at = id.lastIndexOf('@');
  if (at === -1) return id;
  const body = id.slice(0, at);
  const colon = body.indexOf(':');
  return `${colon === -1 ? body : body.slice(0, colon)}${id.slice(at)}`;
}
