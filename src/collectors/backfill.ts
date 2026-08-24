/**
 * Backfill: recupera o que aconteceu antes de o monitor subir.
 *
 * Roda uma vez por boot, por grupo, e resolve dois cenários com a mesma lógica:
 *
 *   - primeiro contato com o grupo → puxa a janela de BACKFILL_DAYS dias;
 *   - retomada após o monitor ficar parado → puxa desde a última mensagem
 *     registrada no checkpoint, então só entra o que é novo.
 *
 * Também reconcilia participantes: compara a lista atual com a do checkpoint e
 * emite as entradas/saídas ocorridas com o processo desligado. Essas mudanças
 * não têm autor nem horário conhecidos — o WhatsApp não guarda esse rastro para
 * quem não estava escutando — então saem marcadas com `detectedOnResume`.
 *
 * A deduplicação é por messageId no checkpoint, então rodar o backfill de novo
 * (ou sobrepor com o listener ao vivo) não duplica evento nenhum.
 *
 * Limite honesto, e ele é grande: **não há carregamento de histórico**. Nesta
 * build do WhatsApp Web toda a família `loadEarlierMsgs` estoura antes de tocar
 * o servidor (investigação em `npm run probe-history`, resumo no CLAUDE.md), e
 * insistir custava três chamadas quebradas por grupo a cada boot sem trazer uma
 * mensagem sequer. O backfill recupera o que o WA Web já tem em memória — o que
 * costuma emendar uma reinicialização curta, e nada além disso. É por isso que
 * uptime é o requisito central do monitor.
 */

import type { Client, Message } from '@open-wa/wa-automate';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, MessagePayload, ParticipantsChangedPayload } from '../types';
import { isSpeech } from '../util/messageTypes';
import { waTimestampToIso } from '../util/phone';
import { createLogger } from '../util/logger';
import { localIso } from '../util/time';
import type { Collector, CollectorContext } from './Collector';
import type { MessageWindow } from './messageWindow';

const log = createLogger('collector:backfill');

export class BackfillCollector implements Collector {
  readonly name = 'backfill';

  constructor(private readonly window: MessageWindow) {}

  async start(ctx: CollectorContext): Promise<void> {
    if (!ctx.config.backfillEnabled) {
      log.info('backfill desabilitado por configuração');
      return;
    }

    for (const group of ctx.config.groups) {
      try {
        await this.backfillGroup(ctx, group.id);
        await this.reconcileParticipants(ctx, group.id);
      } catch (error) {
        log.error('backfill do grupo falhou', { groupId: group.id, error: String(error) });
      }
    }
    ctx.checkpoint.save();
  }

  private async backfillGroup(ctx: CollectorContext, groupId: string): Promise<void> {
    const checkpoint = ctx.checkpoint.get(groupId);

    // A janela é SEMPRE os últimos BACKFILL_DAYS dias, mesmo havendo
    // checkpoint. Antes ela começava na última mensagem registrada, o que
    // parecia uma economia — mas amarrava a cobertura ao que já tinha sido
    // capturado: se uma execução falhasse em ler parte do histórico, o
    // checkpoint avançava mesmo assim e aquele trecho ficava inalcançável para
    // sempre. Reler é barato e a deduplicação por messageId garante que nada
    // seja emitido duas vezes; o checkpoint continua servindo ao dedupe e à
    // reconciliação de participantes.
    const since = Date.now() - ctx.config.backfillDays * 24 * 60 * 60 * 1000;

    log.info('iniciando backfill', {
      groupId,
      desde: localIso(new Date(since)),
      jaRegistradas: checkpoint.emittedMessageIds.length,
    });

    const messages = await this.readStore(ctx, groupId, checkpoint.lastMessageAt);
    if (messages.length === 0) {
      log.info('nada a recuperar', { groupId });
      return;
    }

    // Ordem cronológica: o arquivo fica legível e o checkpoint avança certo.
    // Sobre uma cópia — o array veio do cliente e ordenar no lugar mexeria em
    // estrutura que não é nossa.
    let ordered = [...messages].sort((a, b) => messageTime(a) - messageTime(b));

    if (ordered.length > ctx.config.backfillMaxMessages) {
      log.warn('teto de mensagens do backfill atingido; as mais antigas ficam de fora', {
        groupId,
        emMemoria: ordered.length,
        teto: ctx.config.backfillMaxMessages,
      });
      ordered = ordered.slice(-ctx.config.backfillMaxMessages);
    }

    let emitted = 0;
    let skipped = 0;
    let ignorados = 0;
    for (const message of ordered) {
      const at = messageTime(message);
      if (at < since) continue;

      // Antes da janela: aviso de sistema não recebe reação nem confirmação de
      // leitura, então vigiá-lo seria consulta gasta a cada varredura. E ele
      // também não avança o checkpoint — não é mensagem. Ver
      // `util/messageTypes.ts`.
      if (!isSpeech(message?.type)) {
        ignorados += 1;
        continue;
      }

      const messageId = String(message?.id ?? '');

      // A janela é povoada ANTES do dedupe, de propósito. Uma mensagem já
      // emitida numa execução anterior não pode virar evento de novo — mas
      // precisa voltar a ser observada para reações e confirmações de leitura.
      // Fazendo isso só depois do dedupe, tudo que já era conhecido saía da
      // observação a cada restart, e só o inédito continuava vigiado.
      this.window.track(groupId, messageId, at, Boolean(message.fromMe));

      if (!ctx.checkpoint.markMessageEmitted(groupId, messageId, at)) {
        skipped += 1;
        continue;
      }

      await this.emitMessage(ctx, groupId, message, at);
      emitted += 1;
    }

    log.info('backfill concluído', {
      groupId,
      emitidas: emitted,
      jaConhecidas: skipped,
      semFala: ignorados,
    });
  }

  /**
   * Lê o que o WA Web já tem em memória para este chat.
   *
   * Nenhuma chamada de carregamento: as três rotas conhecidas
   * (`WAPI.loadEarlierMessagesTillDate`, `WAPI.loadEarlierMessages` e
   * `WAWebChatLoadMessages.loadEarlierMsgs`) terminam no mesmo ponto quebrado
   * do bundle do WhatsApp — chamá-las só produzia erro no log.
   *
   * O aviso que importa não é mais "o histórico carregou?", e sim "a emenda
   * fechou?": se a mensagem mais antiga em memória for posterior à última que
   * registramos, existe um intervalo que ninguém viu e que não é recuperável.
   * É esse o número a vigiar num monitor que vive de uptime.
   */
  private async readStore(
    ctx: CollectorContext,
    groupId: string,
    lastMessageAt: number | null,
  ): Promise<Message[]> {
    const chatId = groupId as Parameters<Client['getAllMessagesInChat']>[0];
    const messages = await this.safeGetAll(ctx, chatId);
    const oldest = oldestUsableTime(messages);

    log.info('mensagens em memória', {
      groupId,
      total: messages.length,
      maisAntiga: describeOldest(messages),
    });

    if (lastMessageAt !== null && oldest !== null && oldest > lastMessageAt) {
      log.warn('lacuna: o store não alcança a última mensagem registrada', {
        groupId,
        ultimaRegistrada: localIso(new Date(lastMessageAt)),
        maisAntigaEmMemoria: localIso(new Date(oldest)),
      });
    }

    return messages;
  }

  private async safeGetAll(
    ctx: CollectorContext,
    chatId: Parameters<Client['getAllMessagesInChat']>[0],
  ): Promise<Message[]> {
    try {
      return (await ctx.client.getAllMessagesInChat(chatId, true, false)) ?? [];
    } catch (error) {
      log.warn('getAllMessagesInChat falhou', { error: String(error) });
      return [];
    }
  }

  private async emitMessage(
    ctx: CollectorContext,
    groupId: string,
    message: Message,
    at: number,
  ): Promise<void> {
    const authorId = resolveAuthorId(message);
    const actor = message.fromMe
      ? ((await ctx.roster.resolveSelf()) ?? (await ctx.roster.resolve(authorId)))
      : await ctx.roster.resolve(authorId);

    // A entrada na janela acontece no laço de `backfillGroup`, antes do dedupe.

    const payload: MessagePayload = {
      messageId: String(message.id ?? ''),
      sentAt: waTimestampToIso(message.timestamp ?? (message as { t?: number }).t),
      messageType: String(message.type ?? 'unknown'),
      body: nonEmpty(message.body),
      caption: nonEmpty(message.caption),
      isMedia: Boolean(message.isMedia || message.isMMS),
      mimetype: nonEmpty(message.mimetype),
      fromMe: Boolean(message.fromMe),
      quotedMsgId: nonEmpty(message.quotedMsg?.id as string | undefined),
      mentionedIds: Array.isArray(message.mentionedJidList)
        ? message.mentionedJidList.map(String)
        : [],
      backfill: true,
    };

    const event: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type: 'message',
      capturedAt: localIso(),
      group: { id: groupId, name: await ctx.groupName(groupId) },
      actor,
      payload,
    };

    await ctx.emit(event);
  }

  /** Detecta entradas/saídas ocorridas com o monitor desligado. */
  private async reconcileParticipants(ctx: CollectorContext, groupId: string): Promise<void> {
    const participants = await ctx.roster.groupMembers(groupId, true);
    const diff = ctx.checkpoint.diffParticipants(
      groupId,
      participants.map((p) => p.id),
    );

    if (diff.firstRun || (diff.added.length === 0 && diff.removed.length === 0)) return;

    for (const [action, ids] of [
      ['add', diff.added],
      ['remove', diff.removed],
    ] as const) {
      if (ids.length === 0) continue;

      const payload: ParticipantsChangedPayload = {
        action,
        rawAction: `${action}:detected_on_resume`,
        who: await ctx.roster.resolveMany(ids),
        detectedOnResume: true,
      };

      const event: CapturedEvent = {
        schema: EVENT_SCHEMA_VERSION,
        eventId: ctx.newEventId(),
        type: 'participants_changed',
        capturedAt: localIso(),
        group: { id: groupId, name: await ctx.groupName(groupId) },
        // Sem autor: quem executou a ação não é recuperável depois do fato.
        actor: null,
        payload,
      };

      await ctx.emit(event);
    }

    log.info('participantes reconciliados', {
      groupId,
      entraram: diff.added.length,
      sairam: diff.removed.length,
    });
  }

  async stop(): Promise<void> {
    // Roda uma vez no boot; não há nada em execução para interromper.
  }
}

function messageTime(message: Message): number {
  const raw = message?.timestamp ?? (message as { t?: number })?.t;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e11 ? raw : raw * 1000;
}

/**
 * Epoch ms da mensagem mais antiga com timestamp utilizável, ou null se
 * nenhuma tiver.
 *
 * Ignorar as de tempo 0 é o ponto central: com elas na conta, um único item
 * sem timestamp (notificação de sistema, por exemplo) zerava o mínimo e fazia a
 * paginação concluir que já tinha alcançado o passado.
 */
function oldestUsableTime(messages: readonly Message[]): number | null {
  let oldest: number | null = null;
  for (const message of messages) {
    const at = messageTime(message);
    if (at > 0 && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}

function describeOldest(messages: readonly Message[]): string {
  const oldest = oldestUsableTime(messages);
  return oldest === null ? 'nenhuma com timestamp' : localIso(new Date(oldest));
}

function resolveAuthorId(message: Message): string | null {
  const author = (message as { author?: string }).author;
  if (author) return String(author);
  const sender = (message as { sender?: { id?: string } }).sender?.id;
  if (sender) return String(sender);
  const from = message.from ? String(message.from) : '';
  return from.endsWith('@g.us') ? null : from || null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
