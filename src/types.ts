/**
 * Contrato dos eventos normalizados gravados em data/events.jsonl.
 *
 * Uma linha JSON por evento (JSON Lines). O formato é deliberadamente estável e
 * independente do open-wa: se um dia a fonte mudar (v5, outra lib, Easy API), só
 * os coletores mudam — o consumidor do arquivo continua igual.
 */

export const EVENT_SCHEMA_VERSION = 1;

export type EventType =
  | 'message'
  | 'reaction_added'
  | 'reaction_removed'
  | 'message_read'
  | 'participants_changed'
  | 'group_snapshot'
  | 'session_state';

/** De onde veio o nome exibido. O WhatsApp expõe vários campos e nenhum é garantido. */
export type NameSource = 'contact' | 'formattedName' | 'pushname' | 'shortName' | null;

/** Uma pessoa envolvida no evento, já resolvida para número + nome. */
export interface Actor {
  /** ID canônico do WhatsApp, ex.: "5511999998888@c.us". Use SEMPRE isto para deduplicar. */
  id: string;
  /** Número em formato E.164 quando derivável do id, senão null. */
  phone: string | null;
  /** Nome exibível, ou null quando o contato não tem nenhum nome conhecido. */
  name: string | null;
  nameSource: NameSource;
}

export interface GroupRef {
  id: string;
  name: string | null;
}

export interface BaseEvent {
  schema: typeof EVENT_SCHEMA_VERSION;
  eventId: string;
  type: EventType;
  /** Momento em que ESTE processo capturou o evento (ISO 8601, UTC). */
  capturedAt: string;
  group: GroupRef | null;
  actor: Actor | null;
}

export interface MessagePayload {
  messageId: string;
  /** Timestamp do WhatsApp (ISO 8601), quando disponível. */
  sentAt: string | null;
  /** Tipo bruto do open-wa: chat, image, video, ptt, document, location, ... */
  messageType: string;
  body: string | null;
  caption: string | null;
  isMedia: boolean;
  mimetype: string | null;
  fromMe: boolean;
  quotedMsgId: string | null;
  mentionedIds: string[];
  /**
   * true quando a mensagem veio do backfill (histórico lido no boot) em vez do
   * listener ao vivo. Útil para distinguir captura retroativa de tempo real —
   * `capturedAt` de uma mensagem com backfill:true é muito posterior a `sentAt`.
   */
  backfill: boolean;
}

export interface ReactionPayload {
  /** A mensagem que recebeu a reação. */
  targetMessageId: string;
  emoji: string;
  /** Timestamp da reação (ISO 8601), quando o WhatsApp fornece. */
  reactedAt: string | null;
}

/** De onde a confirmação de leitura foi lida. Só para depuração. */
export type ReadReceiptSource = 'store-cache' | 'store-query' | 'getMessageInfo' | 'getMessageReaders';

/**
 * Uma pessoa abriu uma mensagem enviada pela PRÓPRIA conta.
 *
 * O WhatsApp só entrega confirmação de leitura a quem enviou, então isto existe
 * exclusivamente para mensagens `fromMe` — as que você escreve à mão pelo
 * celular no grupo. O monitor continua sem enviar nada.
 */
export interface MessageReadPayload {
  /** A mensagem própria que foi lida. */
  targetMessageId: string;
  /** Quando a pessoa leu (ISO 8601), quando o WhatsApp informa o horário. */
  readAt: string | null;
  source: ReadReceiptSource;
}

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'leave' | 'unknown';

export interface ParticipantsChangedPayload {
  action: ParticipantAction;
  /** Ação bruta reportada pelo open-wa, preservada para não perder informação. */
  rawAction: string;
  who: Actor[];
  /**
   * true quando a mudança foi inferida no boot, comparando a lista atual com o
   * checkpoint da execução anterior — ou seja, aconteceu com o monitor parado.
   * Nesses casos `actor` é null e o horário exato é desconhecido: o WhatsApp
   * não guarda esse rastro para quem não estava escutando.
   */
  detectedOnResume: boolean;
}

export interface ParticipantSnapshot extends Actor {
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupSnapshotPayload {
  subject: string | null;
  description: string | null;
  owner: string | null;
  participantCount: number;
  participants: ParticipantSnapshot[];
  /** O que disparou o snapshot. */
  reason: 'boot' | 'participants_changed' | 'manual';
}

export interface SessionStatePayload {
  state: string;
  previous: string | null;
}

export type CapturedEvent =
  | (BaseEvent & { type: 'message'; payload: MessagePayload })
  | (BaseEvent & { type: 'reaction_added'; payload: ReactionPayload })
  | (BaseEvent & { type: 'reaction_removed'; payload: ReactionPayload })
  | (BaseEvent & { type: 'message_read'; payload: MessageReadPayload })
  | (BaseEvent & { type: 'participants_changed'; payload: ParticipantsChangedPayload })
  | (BaseEvent & { type: 'group_snapshot'; payload: GroupSnapshotPayload })
  | (BaseEvent & { type: 'session_state'; payload: SessionStatePayload });
