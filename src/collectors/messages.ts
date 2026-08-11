/**
 * Captura mensagens dos grupos monitorados.
 *
 * Usa onAnyMessage (livre de licença na v4) em vez de onMessage para incluir
 * também as mensagens enviadas pela própria conta dona do grupo.
 */

import type { Message } from '@open-wa/wa-automate';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, MessagePayload } from '../types';
import { waTimestampToIso } from '../util/phone';
import { createLogger } from '../util/logger';
import type { Collector, CollectorContext } from './Collector';
import type { MessageWindow } from './messageWindow';

const log = createLogger('collector:messages');

export class MessagesCollector implements Collector {
  readonly name = 'messages';

  constructor(private readonly window: MessageWindow) {}

  async start(ctx: CollectorContext): Promise<void> {
    await ctx.client.onAnyMessage(async (message: Message) => {
      try {
        await this.handle(ctx, message);
      } catch (error) {
        log.error('falha ao processar mensagem', error);
      }
    });
    log.info('escutando onAnyMessage');
  }

  private async handle(ctx: CollectorContext, message: Message): Promise<void> {
    const groupId = resolveGroupId(message);

    // Filtro de whitelist na primeira linha: o que não é monitorado é descartado
    // em memória e nunca chega ao disco.
    if (!ctx.isMonitored(groupId)) return;

    const authorId = resolveAuthorId(message);
    const actor = await ctx.roster.resolve(authorId);
    const sentAt = waTimestampToIso(message.timestamp ?? (message as { t?: number }).t);

    // Registra na janela para o coletor de reações vigiar esta mensagem.
    this.window.track(
      groupId,
      String(message.id ?? ''),
      sentAt ? Date.parse(sentAt) : Date.now(),
    );

    const payload: MessagePayload = {
      messageId: String(message.id ?? ''),
      sentAt,
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

  async stop(): Promise<void> {
    // Os listeners morrem junto com o browser; não há o que desfazer aqui.
  }
}

/** O id do grupo está em `chatId`, ou em `to`/`from` conforme a direção. */
function resolveGroupId(message: Message): string | null {
  const candidates = [
    message.chatId,
    message.to,
    message.from,
    (message as { chat?: { id?: string } }).chat?.id,
  ];
  for (const candidate of candidates) {
    const value = candidate ? String(candidate) : '';
    if (value.endsWith('@g.us')) return value;
  }
  return null;
}

/**
 * Em grupo, `from` é o id do grupo — o autor real vem em `author`.
 * Para mensagens próprias o open-wa nem sempre preenche `author`.
 */
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
