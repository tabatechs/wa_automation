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
 * Limite honesto: no multi-device o WhatsApp só sincroniza uma janela de
 * histórico para os aparelhos conectados. `loadEarlierMessages` vai até onde o
 * WhatsApp entregou e para — não existe "o grupo inteiro desde a criação".
 */

import type { Client, Message } from '@open-wa/wa-automate';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, MessagePayload, ParticipantsChangedPayload } from '../types';
import { waTimestampToIso } from '../util/phone';
import { createLogger } from '../util/logger';
import { HistoryLoader } from '../util/history';
import type { Collector, CollectorContext } from './Collector';
import type { MessageWindow } from './messageWindow';

const log = createLogger('collector:backfill');

export class BackfillCollector implements Collector {
  readonly name = 'backfill';

  /** Criado no primeiro uso: precisa do client, que só existe no start. */
  private loader: HistoryLoader | null = null;

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
      desde: new Date(since).toISOString(),
      jaRegistradas: checkpoint.emittedMessageIds.length,
    });

    const messages = await this.loadUntil(ctx, groupId, since);
    if (messages.length === 0) {
      log.info('nada a recuperar', { groupId });
      return;
    }

    // Ordem cronológica: o arquivo fica legível e o checkpoint avança certo.
    // Sobre uma cópia — o array veio do cliente e ordenar no lugar mexeria em
    // estrutura que não é nossa.
    const ordered = [...messages].sort((a, b) => messageTime(a) - messageTime(b));

    let emitted = 0;
    let skipped = 0;
    for (const message of ordered) {
      const at = messageTime(message);
      if (at < since) continue;

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

    log.info('backfill concluído', { groupId, emitidas: emitted, jaConhecidas: skipped });
  }

  /**
   * Carrega o histórico do servidor até cobrir `since`.
   *
   * O caminho principal é o `HistoryLoader`, que fala com o store do WA Web
   * direto. As funções da lib (`loadEarlierMessagesTillDate` /
   * `loadEarlierMessages`) ficam como última alternativa: as duas terminam em
   * `chat.loadEarlierMsgs()`, que quebrou na build atual do WhatsApp Web — e
   * como a antiga "paginação manual" chamava exatamente essa função, a reserva
   * morria junto com o caminho principal, em silêncio.
   */
  private async loadUntil(
    ctx: CollectorContext,
    groupId: string,
    since: number,
  ): Promise<Message[]> {
    const chatId = groupId as Parameters<Client['getAllMessagesInChat']>[0];

    this.loader ??= new HistoryLoader(ctx.client);
    // Cada passo traz ~50 mensagens; o teto de passos respeita o de mensagens.
    const maxSteps = Math.max(1, Math.ceil(ctx.config.backfillMaxMessages / 50));
    const resultado = await this.loader.loadUntil(groupId, since, maxSteps);

    if (!resultado.ok) {
      // Caminhos da lib como reserva. Nesta build do WA Web os dois terminam em
      // `chat.loadEarlierMsgs()` e falham junto, mas cobrem builds mais antigas
      // — e a paginação manual é o que o commit da regressão deixou testado.
      try {
        await ctx.client.loadEarlierMessagesTillDate(
          chatId as Parameters<Client['loadEarlierMessagesTillDate']>[0],
          Math.floor(since / 1000),
        );
      } catch (error) {
        log.warn('loadEarlierMessagesTillDate falhou; caindo para paginação manual', {
          groupId,
          error: String(error),
        });
        await this.paginateManually(ctx, chatId, since);
      }
    }

    const messages = await this.safeGetAll(ctx, chatId);
    log.info('histórico carregado', {
      groupId,
      mensagensNoStore: messages.length,
      maisAntiga: describeOldest(messages),
      rota: resultado.route,
      passos: resultado.steps,
      cobriuAJanela: resultado.covered,
    });

    // O alarme olha o que temos de fato, não o que a rota disse ter feito: o
    // store pode já estar quente por outro motivo. Antes isto falhava calado —
    // `mensagensNoStore: 1` num grupo ativo parecia linha de rotina, e é o
    // sintoma mais importante que o monitor pode dar. Sem histórico, um
    // reinício perde tudo que aconteceu no intervalo.
    const oldest = oldestUsableTime(messages);
    const cobriu = oldest !== null && oldest <= since;

    if (messages.length <= 1) {
      log.error(
        'HISTÓRICO NÃO CARREGOU — o monitor vai capturar apenas o que chegar ao vivo, ' +
          'e um reinício perderá o intervalo',
        { groupId, mensagensNoStore: messages.length, rota: resultado.route },
      );
    } else if (!resultado.ok) {
      log.warn('não foi possível paginar; seguindo com o que já estava no store', {
        groupId,
        mensagensNoStore: messages.length,
      });
    } else if (!cobriu) {
      log.warn('histórico não cobriu a janela inteira; o WhatsApp entregou só até onde tinha', {
        groupId,
        desde: new Date(since).toISOString(),
        maisAntiga: describeOldest(messages),
      });
    }

    if (messages.length >= ctx.config.backfillMaxMessages) {
      log.warn('teto de mensagens do backfill atingido; histórico pode estar incompleto', {
        groupId,
        teto: ctx.config.backfillMaxMessages,
      });
    }
    return messages;
  }

  /**
   * Última reserva: pagina de 50 em 50 até cobrir `since` ou parar de progredir.
   *
   * Continua aqui mesmo com o `HistoryLoader` na frente porque é o caminho que
   * o commit da regressão de paginação deixou coberto por teste — e porque numa
   * build antiga do WA Web ele ainda é o que funciona.
   */
  private async paginateManually(
    ctx: CollectorContext,
    chatId: Parameters<Client['getAllMessagesInChat']>[0],
    since: number,
  ): Promise<void> {
    let previousCount = -1;
    let messages = await this.safeGetAll(ctx, chatId);

    while (messages.length < ctx.config.backfillMaxMessages && messages.length !== previousCount) {
      // Só mensagens com timestamp utilizável entram na conta. Considerar as de
      // tempo 0 (notificações de sistema, por exemplo) derrubava `oldest` para
      // zero e encerrava a paginação na primeira volta.
      const oldest = oldestUsableTime(messages);
      if (oldest !== null && oldest <= since) break;

      previousCount = messages.length;
      try {
        await ctx.client.loadEarlierMessages(chatId as Parameters<Client['loadEarlierMessages']>[0]);
      } catch (error) {
        log.debug('loadEarlierMessages parou', { error: String(error) });
        break;
      }
      messages = await this.safeGetAll(ctx, chatId);
    }
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
      capturedAt: new Date().toISOString(),
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
        capturedAt: new Date().toISOString(),
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
  return oldest === null ? 'nenhuma com timestamp' : new Date(oldest).toISOString();
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
