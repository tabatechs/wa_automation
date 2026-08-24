/**
 * Traduz eventos capturados em escritas no MongoDB.
 *
 * ## A garantia central: reprocessar não conta duas vezes
 *
 * O `eventId` é um UUID novo a cada emissão — reimportar o JSONL com ele como
 * chave duplicaria tudo. Por isso todo documento de domínio tem `_id`
 * determinístico, derivado do conteúdo, e a ingestão acontece em duas fases:
 *
 *   1. **Fatos** — upsert dos documentos de domínio (`messages`, `reactions`,
 *      `member_events`). O `bulkWrite` devolve em `upsertedIds` exatamente
 *      quais documentos foram criados *agora*.
 *   2. **Contadores** — só os documentos da fase 1 que eram novos geram `$inc`.
 *
 * Reprocessar o mesmo evento passa pela fase 1 sem criar nada e, portanto,
 * não chega na fase 2. É o que permite rodar `mongo:import` quantas vezes
 * quiser e refazer backfill sem estragar as métricas.
 *
 * ## O que é contado aqui e o que fica para o recálculo
 *
 * O caminho quente conta **o que a pessoa fez**: mensagens enviadas, reações
 * dadas, respostas enviadas. O que ela **recebeu** — reações recebidas,
 * respostas recebidas, menções recebidas — fica para o recálculo agendado, que
 * soma a partir de `messages`. Isso não é economia: é correção. Uma reação
 * costuma chegar antes da mensagem que ela reage (o backfill lê o histórico
 * fora de ordem), e creditar o autor no caminho quente exigiria uma busca que
 * às vezes não teria resposta. Somando no fim, a ordem de chegada não importa.
 */

import type { AnyBulkWriteOperation, Document } from 'mongodb';
import type {
  CapturedEvent,
  GroupSnapshotPayload,
  MessagePayload,
  MessageReadPayload,
  ParticipantsChangedPayload,
  ReactionPayload,
} from '../types';
import { createLogger } from '../util/logger';
import { isSpeech } from '../util/messageTypes';
import { timeParts } from '../util/time';
import { resolveIdentity, stableActorKey, type PersonIdentity } from './identity';
import type { MongoStore } from './client';
import {
  COLLECTIONS,
  type ActivityDailyDoc,
  type GroupDoc,
  type MemberEventDoc,
  type MessageDoc,
  type MessageReadDoc,
  type PersonDoc,
  type ReactionDoc,
  type RawEventDoc,
} from './schema';

const log = createLogger('mongo:ingest');

const URL_PATTERN = /https?:\/\/\S+/g;

/** Vínculo pessoa↔grupo pendente de gravação em `people.groups[]`. */
interface GroupLink {
  personId: string;
  groupId: string;
  isAdmin?: boolean;
  active?: boolean;
  joinedAt?: Date;
  leftAt?: Date;
}

type GroupLinkPatch = Omit<GroupLink, 'personId' | 'groupId'>;

// ---------------------------------------------------------------------------
// acumulador de contadores
// ---------------------------------------------------------------------------

/**
 * Junta os `$inc` de vários eventos antes de mandar pro banco. Cem mensagens
 * do mesmo grupo viram uma escrita em `groups`, não cem.
 */
class CounterBatch {
  private readonly people = new Map<string, PersonAccumulator>();
  private readonly groups = new Map<string, GroupAccumulator>();
  private readonly daily = new Map<string, DailyAccumulator>();
  private readonly messageRollups = new Map<
    string,
    { reactionsCount?: number; repliesCount?: number; readsCount?: number }
  >();

  person(identity: PersonIdentity): PersonAccumulator {
    let acc = this.people.get(identity.personId);
    if (!acc) {
      acc = new PersonAccumulator(identity);
      this.people.set(identity.personId, acc);
    } else {
      acc.mergeIdentity(identity);
    }
    return acc;
  }

  group(groupId: string, name: string | null): GroupAccumulator {
    let acc = this.groups.get(groupId);
    if (!acc) {
      acc = new GroupAccumulator(groupId);
      this.groups.set(groupId, acc);
    }
    if (name) acc.subject = name;
    return acc;
  }

  day(groupId: string, personId: string | null, date: string): DailyAccumulator {
    const id = `${groupId}|${personId ?? '_all'}|${date}`;
    let acc = this.daily.get(id);
    if (!acc) {
      acc = new DailyAccumulator(id, groupId, personId, date);
      this.daily.set(id, acc);
    }
    return acc;
  }

  /** Rollup na própria mensagem alvo: quantas reações ela recebeu. */
  addReactionToMessage(messageId: string, delta: number): void {
    const current = this.messageRollups.get(messageId) ?? {};
    current.reactionsCount = (current.reactionsCount ?? 0) + delta;
    this.messageRollups.set(messageId, current);
  }

  /** Rollup na mensagem citada: quantas respostas ela puxou. */
  addReplyToMessage(messageId: string, delta: number): void {
    const current = this.messageRollups.get(messageId) ?? {};
    current.repliesCount = (current.repliesCount ?? 0) + delta;
    this.messageRollups.set(messageId, current);
  }

  /** Rollup na mensagem própria: quantas pessoas a abriram. */
  addReadToMessage(messageId: string, delta: number): void {
    const current = this.messageRollups.get(messageId) ?? {};
    current.readsCount = (current.readsCount ?? 0) + delta;
    this.messageRollups.set(messageId, current);
  }

  /**
   * Vínculos pessoa↔grupo pendentes de gravação, achatados. Vão numa fase
   * própria porque atualizar um elemento de array exige que ele já exista.
   */
  groupLinks(): GroupLink[] {
    const links: GroupLink[] = [];
    for (const person of this.people.values()) {
      for (const [groupId, patch] of person.groupIds()) {
        links.push({ personId: person.personId, groupId, ...patch });
      }
    }
    return links;
  }

  isEmpty(): boolean {
    return (
      this.people.size === 0 &&
      this.groups.size === 0 &&
      this.daily.size === 0 &&
      this.messageRollups.size === 0
    );
  }

  peopleOps(): AnyBulkWriteOperation<PersonDoc>[] {
    return [...this.people.values()].map((a) => a.toOp());
  }

  groupOps(): AnyBulkWriteOperation<GroupDoc>[] {
    return [...this.groups.values()].map((a) => a.toOp());
  }

  dailyOps(): AnyBulkWriteOperation<ActivityDailyDoc>[] {
    return [...this.daily.values()].map((a) => a.toOp());
  }

  messageRollupOps(): AnyBulkWriteOperation<MessageDoc>[] {
    const ops: AnyBulkWriteOperation<MessageDoc>[] = [];
    for (const [messageId, rollup] of this.messageRollups) {
      const inc: Record<string, number> = {};
      if (rollup.reactionsCount) inc.reactionsCount = rollup.reactionsCount;
      if (rollup.repliesCount) inc.repliesCount = rollup.repliesCount;
      if (rollup.readsCount) inc.readsCount = rollup.readsCount;
      if (Object.keys(inc).length === 0) continue;
      ops.push({
        updateOne: {
          filter: { _id: messageId },
          update: { $inc: inc },
          // Sem upsert: se a mensagem alvo ainda não chegou, o recálculo
          // conserta a conta somando direto de `reactions` e `messages`.
          upsert: false,
        },
      });
    }
    return ops;
  }
}

class PersonAccumulator {
  private readonly inc: Record<string, number> = {};
  private readonly aliases = new Set<string>();
  private readonly emojis = new Set<string>();
  private readonly groupLinks = new Map<string, GroupLinkPatch>();
  private maxSeenAt: Date | null = null;
  private maxMessageAt: Date | null = null;
  private minSeenAt: Date | null = null;

  constructor(private identity: PersonIdentity) {
    for (const alias of identity.aliases) this.aliases.add(alias);
  }

  mergeIdentity(next: PersonIdentity): void {
    for (const alias of next.aliases) this.aliases.add(alias);
    // Um nome resolvido vale mais que um nulo; telefone idem.
    if (!this.identity.name && next.name) this.identity = { ...this.identity, ...next };
    else if (!this.identity.phone && next.phone) this.identity = { ...this.identity, ...next };
  }

  add(field: string, delta = 1): this {
    this.inc[field] = (this.inc[field] ?? 0) + delta;
    return this;
  }

  emoji(value: string): this {
    this.emojis.add(value);
    return this;
  }

  seenAt(when: Date | null): this {
    if (!when) return this;
    if (!this.maxSeenAt || when > this.maxSeenAt) this.maxSeenAt = when;
    if (!this.minSeenAt || when < this.minSeenAt) this.minSeenAt = when;
    return this;
  }

  messageAt(when: Date | null): this {
    if (when && (!this.maxMessageAt || when > this.maxMessageAt)) this.maxMessageAt = when;
    return this.seenAt(when);
  }

  /** Garante que a pessoa aparece como membro do grupo, sem duplicar a entrada. */
  linkGroup(groupId: string, patch: GroupLinkPatch = {}): this {
    this.groupLinks.set(groupId, { ...this.groupLinks.get(groupId), ...patch });
    return this;
  }

  groupIds(): Array<[string, GroupLinkPatch]> {
    return [...this.groupLinks.entries()];
  }

  get personId(): string {
    return this.identity.personId;
  }

  toOp(): AnyBulkWriteOperation<PersonDoc> {
    // `origin` vai em `$set`, e não em `$setOnInsert`, de propósito: a
    // importação de planilha cria documentos `external` com o mesmo `_id` que
    // esta pessoa teria (o telefone). Quando ela finalmente aparece num grupo,
    // o upsert encontra o documento já existente — um `$setOnInsert` não
    // dispararia, o marcador de planilha sobreviveria e a pessoa ficaria fora
    // das métricas para sempre. Escrito a cada evento, a regra é simples: se o
    // monitor observou, é observada, e os campos de planilha continuam ali.
    const set: Document = { updatedAt: new Date(), origin: 'whatsapp' };
    // Só sobrescreve identidade quando há valor: um evento sem nome não pode
    // apagar o nome que outro evento já resolveu.
    if (this.identity.name) {
      set.name = this.identity.name;
      set.nameSource = this.identity.nameSource;
    }
    if (this.identity.phone) {
      set.phone = this.identity.phone;
      set.ddd = this.identity.ddd;
      set.isInternational = this.identity.isInternational;
      set.isMobile = this.identity.isMobile;
    }

    const update: Document = { $set: set };
    if (Object.keys(this.inc).length) update.$inc = this.inc;

    const addToSet: Document = {};
    if (this.aliases.size) addToSet.aliases = { $each: [...this.aliases] };
    if (this.emojis.size) addToSet.emojisUsed = { $each: [...this.emojis] };
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    const max: Document = {};
    if (this.maxSeenAt) max.lastSeenAt = this.maxSeenAt;
    if (this.maxMessageAt) max.lastMessageAt = this.maxMessageAt;
    if (Object.keys(max).length) update.$max = max;

    // `$min` num campo inexistente grava o valor; é o que queremos no primeiro
    // evento de uma pessoa.
    if (this.minSeenAt) update.$min = { firstSeenAt: this.minSeenAt };

    return {
      updateOne: {
        filter: { _id: this.personId },
        update,
        upsert: true,
      },
    } as AnyBulkWriteOperation<PersonDoc>;
  }
}

class GroupAccumulator {
  private readonly inc: Record<string, number> = {};
  subject: string | null = null;
  private maxEventAt: Date | null = null;
  private maxMessageAt: Date | null = null;
  private minEventAt: Date | null = null;

  constructor(readonly groupId: string) {}

  add(field: string, delta = 1): this {
    this.inc[field] = (this.inc[field] ?? 0) + delta;
    return this;
  }

  eventAt(when: Date | null): this {
    if (!when) return this;
    if (!this.maxEventAt || when > this.maxEventAt) this.maxEventAt = when;
    if (!this.minEventAt || when < this.minEventAt) this.minEventAt = when;
    return this;
  }

  messageAt(when: Date | null): this {
    if (when && (!this.maxMessageAt || when > this.maxMessageAt)) this.maxMessageAt = when;
    return this.eventAt(when);
  }

  toOp(): AnyBulkWriteOperation<GroupDoc> {
    const set: Document = { updatedAt: new Date() };
    if (this.subject) set.subject = this.subject;

    const update: Document = { $set: set };
    if (Object.keys(this.inc).length) update.$inc = this.inc;

    const max: Document = {};
    if (this.maxEventAt) max.lastEventAt = this.maxEventAt;
    if (this.maxMessageAt) max.lastMessageAt = this.maxMessageAt;
    if (Object.keys(max).length) update.$max = max;
    if (this.minEventAt) update.$min = { firstEventAt: this.minEventAt };

    return {
      updateOne: { filter: { _id: this.groupId }, update, upsert: true },
    } as AnyBulkWriteOperation<GroupDoc>;
  }
}

class DailyAccumulator {
  private readonly inc: Record<string, number> = {};

  constructor(
    readonly id: string,
    private readonly groupId: string,
    private readonly personId: string | null,
    private readonly date: string,
  ) {}

  add(field: string, delta = 1): this {
    this.inc[field] = (this.inc[field] ?? 0) + delta;
    return this;
  }

  toOp(): AnyBulkWriteOperation<ActivityDailyDoc> {
    return {
      updateOne: {
        filter: { _id: this.id },
        update: {
          $setOnInsert: { groupId: this.groupId, personId: this.personId, date: this.date },
          ...(Object.keys(this.inc).length ? { $inc: this.inc } : {}),
        },
        upsert: true,
      },
    } as AnyBulkWriteOperation<ActivityDailyDoc>;
  }
}

// ---------------------------------------------------------------------------
// fase 1: fatos
// ---------------------------------------------------------------------------

interface FactWrite<T extends Document> {
  id: string;
  op: AnyBulkWriteOperation<T>;
  event: CapturedEvent;
}

function messageFact(event: CapturedEvent, payload: MessagePayload): FactWrite<MessageDoc> | null {
  const groupId = event.group?.id;
  if (!groupId || !payload.messageId) return null;

  // O coletor já descarta aviso de sistema, mas o filtro precisa existir aqui
  // também: o JSONL histórico tem `gp2` gravado, e sem isto um `mongo:import`
  // ou um `mongo:migrate` os traria de volta para `messages`. Ver
  // `util/messageTypes.ts`.
  if (!isSpeech(payload.messageType)) return null;

  const identity = resolveIdentity(event.actor);
  const sentAt = payload.sentAt ? new Date(payload.sentAt) : null;
  const when = sentAt ?? new Date(event.capturedAt);
  const parts = timeParts(when);
  const text = payload.body ?? payload.caption ?? '';
  const pollOptions = extractPollOptions(payload);

  const doc: Omit<
    MessageDoc,
    | 'reactionsCount'
    | 'distinctReactors'
    | 'repliesCount'
    | 'readsCount'
    | 'authorId'
    | 'authorActorId'
  > = {
    _id: payload.messageId,
    groupId,
    sentAt,
    capturedAt: new Date(event.capturedAt),
    messageType: payload.messageType,
    body: payload.body,
    caption: payload.caption,
    len: text.length,
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
    linkCount: (text.match(URL_PATTERN) ?? []).length,
    isMedia: payload.isMedia,
    mimetype: payload.mimetype,
    fromMe: payload.fromMe,
    backfill: payload.backfill ?? false,
    quotedMsgId: payload.quotedMsgId,
    mentionedIds: payload.mentionedIds ?? [],
    hour: parts.hour,
    weekday: parts.weekday,
    isPoll: pollOptions !== null,
    pollOptions,
  };

  return {
    id: payload.messageId,
    event,
    op: {
      updateOne: {
        filter: { _id: payload.messageId },
        update: {
          $set: doc,
          $setOnInsert: {
            // Rollups nunca são reescritos pelo evento da mensagem: uma reação
            // pode ter chegado antes e já ter incrementado a conta.
            reactionsCount: 0,
            distinctReactors: 0,
            repliesCount: 0,
            readsCount: 0,
            // `authorId` também só é gravado na criação. Quando um `lid:`
            // provisório é fundido com a pessoa de telefone conhecido, o
            // recálculo reponta esta coluna; reescrevê-la a cada reprocessamento
            // desfaria a fusão e a identidade ficaria oscilando entre as duas.
            authorId: identity?.personId ?? null,
            authorActorId: event.actor?.id ?? null,
          },
        },
        upsert: true,
      },
    } as AnyBulkWriteOperation<MessageDoc>,
  };
}

/**
 * Enquetes ainda não são capturadas (ver `probe-polls`), mas o campo já existe
 * no evento quando o open-wa entrega — detectar por `pollOptions` é o caminho,
 * porque o enum de tipos de mensagem não tem membro de enquete.
 */
function extractPollOptions(payload: MessagePayload): string[] | null {
  const raw = (payload as unknown as { pollOptions?: unknown }).pollOptions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw
    .map((o) => (typeof o === 'string' ? o : String((o as { name?: unknown })?.name ?? '')))
    .filter(Boolean);
}

function reactionFact(
  event: CapturedEvent,
  payload: ReactionPayload,
): FactWrite<ReactionDoc> | null {
  const groupId = event.group?.id;
  const identity = resolveIdentity(event.actor);
  const actorKey = stableActorKey(event.actor);
  if (!groupId || !identity || !actorKey || !payload.targetMessageId || !payload.emoji) return null;

  // A chave é o id do WhatsApp, não o `personId`: o `personId` muda quando o
  // telefone da pessoa é descoberto, e isso criaria um segundo documento para
  // a mesma reação — contando-a duas vezes.
  const id = `${payload.targetMessageId}|${actorKey}|${payload.emoji}`;
  const addedAt = payload.reactedAt ? new Date(payload.reactedAt) : new Date(event.capturedAt);

  return {
    id,
    event,
    op: {
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            groupId,
            targetMessageId: payload.targetMessageId,
            emoji: payload.emoji,
            active: true,
            addedAt,
            removedAt: null,
          },
          // `personId` só na criação — o recálculo o reponta ao fundir
          // identidades, e reescrever aqui desfaria a fusão.
          $setOnInsert: { personId: identity.personId, targetAuthorId: null },
        },
        upsert: true,
      },
    } as AnyBulkWriteOperation<ReactionDoc>,
  };
}

/**
 * Quem abriu uma mensagem sua.
 *
 * Sem `active`/`removedAt` como nas reações: leitura não se desfaz. E como o
 * evento só é emitido na primeira vez que aquele leitor aparece, o upsert aqui
 * é puro seguro contra reprocessamento do JSONL.
 */
function messageReadFact(
  event: CapturedEvent,
  payload: MessageReadPayload,
): FactWrite<MessageReadDoc> | null {
  const groupId = event.group?.id;
  const identity = resolveIdentity(event.actor);
  const actorKey = stableActorKey(event.actor);
  if (!groupId || !identity || !actorKey || !payload.targetMessageId) return null;

  // Chave pelo id do WhatsApp e não pelo `personId`, pelo mesmo motivo das
  // reações: o `personId` muda quando o telefone é descoberto.
  const id = `${payload.targetMessageId}|${actorKey}`;
  const readAt = payload.readAt ? new Date(payload.readAt) : new Date(event.capturedAt);

  return {
    id,
    event,
    op: {
      updateOne: {
        filter: { _id: id },
        update: {
          $set: { groupId, targetMessageId: payload.targetMessageId, readAt },
          $setOnInsert: { personId: identity.personId },
        },
        upsert: true,
      },
    } as AnyBulkWriteOperation<MessageReadDoc>,
  };
}

function memberEventFacts(
  event: CapturedEvent,
  payload: ParticipantsChangedPayload,
): FactWrite<MemberEventDoc>[] {
  const groupId = event.group?.id;
  if (!groupId) return [];

  const by = resolveIdentity(event.actor);
  const capturedAt = new Date(event.capturedAt);
  // `who` às vezes vem vazio: o open-wa não entregou os ids. O evento ainda
  // conta como movimento do grupo, então vira um registro sem pessoa.
  const targets = payload.who.length > 0 ? payload.who : [null];

  return targets.map((actor) => {
    const who = actor ? resolveIdentity(actor) : null;
    // Chave pelo id do WhatsApp, estável mesmo quando o telefone é descoberto
    // depois; ver o comentário em `reactionFact`.
    const whoKey = actor ? stableActorKey(actor) : null;
    const id = `${groupId}|${payload.action}|${whoKey ?? '_'}|${event.capturedAt}`;
    return {
      id,
      event,
      op: {
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              groupId,
              action: payload.action,
              rawAction: payload.rawAction,
              detectedOnResume: payload.detectedOnResume,
              capturedAt,
            },
            $setOnInsert: {
              personId: who?.personId ?? null,
              byPersonId: by?.personId ?? null,
            },
          },
          upsert: true,
        },
      } as AnyBulkWriteOperation<MemberEventDoc>,
    };
  });
}

// ---------------------------------------------------------------------------
// fase 2: contadores, só para os fatos que são novos
// ---------------------------------------------------------------------------

function countMessage(batch: CounterBatch, event: CapturedEvent, payload: MessagePayload): void {
  const groupId = event.group?.id;
  if (!groupId) return;

  const identity = resolveIdentity(event.actor);
  const sentAt = payload.sentAt ? new Date(payload.sentAt) : null;
  const when = sentAt ?? new Date(event.capturedAt);
  const parts = timeParts(when);
  const text = payload.body ?? payload.caption ?? '';
  const links = (text.match(URL_PATTERN) ?? []).length;

  const group = batch.group(groupId, event.group?.name ?? null);
  group.add('totalMessages').messageAt(when);
  group.add(`hourHistogram.${parts.hour}`).add(`weekdayHistogram.${parts.weekday}`);
  if (payload.isMedia) group.add('mediaMessages');
  if (payload.quotedMsgId) group.add('messagesWithReply');

  const day = batch.day(groupId, null, parts.date);
  day.add('messages').add('chars', text.length);
  if (payload.isMedia) day.add('mediaMessages');

  if (!identity) return;

  const person = batch.person(identity);
  // Só garante que o vínculo existe: quem decide `active` é evento de entrada/
  // saída ou snapshot. Uma mensagem antiga do backfill não pode "reativar"
  // alguém que já saiu do grupo.
  person.add('messagesSent').messageAt(when).linkGroup(groupId);
  person.add(`hourHistogram.${parts.hour}`).add(`weekdayHistogram.${parts.weekday}`);
  person.add('charsSent', text.length);
  if (payload.isMedia) person.add('mediaSent');
  if (links) person.add('linksShared', links);
  if (payload.quotedMsgId) person.add('repliesSent');
  if (payload.mentionedIds?.length) person.add('mentionsMade', payload.mentionedIds.length);

  const personDay = batch.day(groupId, identity.personId, parts.date);
  personDay.add('messages').add('chars', text.length);
  if (payload.isMedia) personDay.add('mediaMessages');
  if (payload.quotedMsgId) personDay.add('repliesSent');

  // A mensagem citada ganha o rollup aqui; quem a escreveu recebe o crédito no
  // recálculo, somando `repliesCount` por autor. Assim não importa se a citada
  // ainda nem chegou ao banco.
  if (payload.quotedMsgId) batch.addReplyToMessage(payload.quotedMsgId, 1);
}

function countReaction(
  batch: CounterBatch,
  event: CapturedEvent,
  payload: ReactionPayload,
  delta: 1 | -1,
): void {
  const groupId = event.group?.id;
  const identity = resolveIdentity(event.actor);
  if (!groupId) return;

  const when = payload.reactedAt ? new Date(payload.reactedAt) : new Date(event.capturedAt);
  const parts = timeParts(when);

  batch.group(groupId, event.group?.name ?? null).add('totalReactions', delta).eventAt(when);
  batch.addReactionToMessage(payload.targetMessageId, delta);
  batch.day(groupId, null, parts.date).add('reactionsGiven', delta);

  if (!identity) return;
  const person = batch.person(identity);
  person.add('reactionsGiven', delta).seenAt(when).linkGroup(groupId);
  if (delta > 0) person.emoji(payload.emoji);
  batch.day(groupId, identity.personId, parts.date).add('reactionsGiven', delta);
}

function countRead(batch: CounterBatch, event: CapturedEvent, payload: MessageReadPayload): void {
  const groupId = event.group?.id;
  const identity = resolveIdentity(event.actor);
  if (!groupId) return;

  const when = payload.readAt ? new Date(payload.readAt) : new Date(event.capturedAt);
  const parts = timeParts(when);

  batch.group(groupId, event.group?.name ?? null).add('totalReads').eventAt(when);
  batch.addReadToMessage(payload.targetMessageId, 1);
  batch.day(groupId, null, parts.date).add('messagesRead');

  if (!identity) return;
  // `seenAt` sim, `messageAt` não: ler é sinal de presença, não de fala.
  // Contaminar `lastMessageAt` estragaria o corte de quem "não fala há X dias".
  const person = batch.person(identity);
  person.add('messagesRead').seenAt(when).linkGroup(groupId);
  batch.day(groupId, identity.personId, parts.date).add('messagesRead');
}

function countMemberEvent(
  batch: CounterBatch,
  event: CapturedEvent,
  payload: ParticipantsChangedPayload,
): void {
  const groupId = event.group?.id;
  if (!groupId) return;

  const group = batch.group(groupId, event.group?.name ?? null);
  group.eventAt(new Date(event.capturedAt));
  if (payload.action === 'add') group.add('joins', Math.max(payload.who.length, 1));
  if (payload.action === 'remove' || payload.action === 'leave') {
    group.add('leaves', Math.max(payload.who.length, 1));
  }

  const at = new Date(event.capturedAt);
  for (const actor of payload.who) {
    const identity = resolveIdentity(actor);
    if (!identity) continue;
    const person = batch.person(identity);
    person.seenAt(at);
    switch (payload.action) {
      case 'add':
        // `detectedOnResume` significa "já estava lá quando voltamos a olhar":
        // a pessoa entrou em algum momento que não observamos, então carimbar
        // a data de agora seria inventar um histórico.
        person.linkGroup(groupId, {
          active: true,
          ...(payload.detectedOnResume ? {} : { joinedAt: at }),
        });
        break;
      case 'remove':
      case 'leave':
        person.linkGroup(groupId, {
          active: false,
          ...(payload.detectedOnResume ? {} : { leftAt: at }),
        });
        break;
      case 'promote':
        person.linkGroup(groupId, { isAdmin: true, active: true });
        break;
      case 'demote':
        person.linkGroup(groupId, { isAdmin: false, active: true });
        break;
      default:
        person.linkGroup(groupId);
    }
  }
}

// ---------------------------------------------------------------------------
// ingestão
// ---------------------------------------------------------------------------

export interface IngestStats {
  messages: number;
  reactions: number;
  reads: number;
  memberEvents: number;
  snapshots: number;
  skipped: number;
}

export class Ingestor {
  constructor(
    private readonly store: MongoStore,
    private readonly rawLog: boolean,
  ) {}

  /**
   * Processa um lote de eventos. Nunca lança: uma falha de banco vira log e o
   * lote é descartado — o JSONL continua sendo o registro durável.
   */
  async apply(events: CapturedEvent[]): Promise<IngestStats> {
    const stats: IngestStats = {
      messages: 0, reactions: 0, reads: 0, memberEvents: 0, snapshots: 0, skipped: 0,
    };
    if (events.length === 0) return stats;

    try {
      await this.applyInternal(events, stats);
    } catch (error) {
      log.error('falha ao gravar lote no MongoDB', error);
    }
    return stats;
  }

  private async applyInternal(events: CapturedEvent[], stats: IngestStats): Promise<void> {
    const batch = new CounterBatch();

    // --- fase 1: fatos ---
    const messageFacts: FactWrite<MessageDoc>[] = [];
    const reactionFacts: FactWrite<ReactionDoc>[] = [];
    const readFacts: FactWrite<MessageReadDoc>[] = [];
    const memberFacts: FactWrite<MemberEventDoc>[] = [];
    const removals: CapturedEvent[] = [];
    const snapshots: CapturedEvent[] = [];

    for (const event of events) {
      switch (event.type) {
        case 'message': {
          const fact = messageFact(event, event.payload);
          if (fact) messageFacts.push(fact);
          else stats.skipped += 1;
          break;
        }
        case 'reaction_added': {
          const fact = reactionFact(event, event.payload);
          if (fact) reactionFacts.push(fact);
          else stats.skipped += 1;
          break;
        }
        case 'reaction_removed':
          removals.push(event);
          break;
        case 'message_read': {
          const fact = messageReadFact(event, event.payload);
          if (fact) readFacts.push(fact);
          else stats.skipped += 1;
          break;
        }
        case 'participants_changed':
          memberFacts.push(...memberEventFacts(event, event.payload));
          break;
        case 'group_snapshot':
          snapshots.push(event);
          break;
        default:
          break; // session_state não tem métrica associada
      }
    }

    const newMessages = await this.writeFacts(COLLECTIONS.messages, messageFacts);
    const newReactions = await this.writeFacts(COLLECTIONS.reactions, reactionFacts);
    const newReads = await this.writeFacts(COLLECTIONS.messageReads, readFacts);
    const newMembers = await this.writeFacts(COLLECTIONS.memberEvents, memberFacts);

    stats.messages = newMessages.length;
    stats.reactions = newReactions.length;
    stats.reads = newReads.length;
    stats.memberEvents = newMembers.length;

    // --- fase 2: contadores, só do que é novo ---
    for (const fact of newMessages) {
      if (fact.event.type === 'message') countMessage(batch, fact.event, fact.event.payload);
    }
    for (const fact of newReactions) {
      if (fact.event.type === 'reaction_added') {
        countReaction(batch, fact.event, fact.event.payload, 1);
      }
    }
    for (const fact of newReads) {
      if (fact.event.type === 'message_read') countRead(batch, fact.event, fact.event.payload);
    }
    for (const fact of newMembers) {
      if (fact.event.type === 'participants_changed') {
        countMemberEvent(batch, fact.event, fact.event.payload);
      }
    }

    // Remoções de reação são raras e precisam saber se havia algo ativo, o que
    // o resultado agregado de um bulkWrite não diz. Vão uma a uma.
    for (const event of removals) {
      if (event.type !== 'reaction_removed') continue;
      if (await this.deactivateReaction(event)) {
        countReaction(batch, event, event.payload, -1);
      }
    }

    for (const event of snapshots) {
      if (event.type === 'group_snapshot') {
        this.countSnapshot(batch, event, event.payload);
        stats.snapshots += 1;
      }
    }

    await this.flushCounters(batch);
    await this.writeRawLog(events);
  }

  /** Executa os upserts e devolve só os que criaram documento agora. */
  private async writeFacts<T extends Document>(
    name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
    facts: FactWrite<T>[],
  ): Promise<FactWrite<T>[]> {
    if (facts.length === 0) return [];
    const collection = await this.store.collection<T>(name);
    if (!collection) return [];

    // Deduplica dentro do próprio lote: o mesmo id duas vezes no mesmo
    // bulkWrite geraria um upsert e um update, e só o primeiro contaria.
    const unique = new Map<string, FactWrite<T>>();
    for (const fact of facts) if (!unique.has(fact.id)) unique.set(fact.id, fact);
    const ordered = [...unique.values()];

    const result = await collection.bulkWrite(
      ordered.map((f) => f.op),
      { ordered: false },
    );

    // `upsertedIds` mapeia o índice da operação para o `_id` criado — é
    // exatamente a lista de fatos que são novos neste lote.
    const created: FactWrite<T>[] = [];
    for (const index of Object.keys(result.upsertedIds ?? {})) {
      const fact = ordered[Number(index)];
      if (fact) created.push(fact);
    }
    return created;
  }

  /** Desativa uma reação. Devolve true só se ela estava ativa. */
  private async deactivateReaction(event: CapturedEvent): Promise<boolean> {
    if (event.type !== 'reaction_removed') return false;
    const identity = resolveIdentity(event.actor);
    if (!identity) return false;

    const collection = await this.store.collection<ReactionDoc>(COLLECTIONS.reactions);
    if (!collection) return false;

    const actorKey = stableActorKey(event.actor);
    if (!actorKey) return false;
    const id = `${event.payload.targetMessageId}|${actorKey}|${event.payload.emoji}`;
    const result = await collection.updateOne(
      { _id: id, active: true },
      { $set: { active: false, removedAt: new Date(event.capturedAt) } },
    );
    return result.modifiedCount === 1;
  }

  /**
   * Snapshots não viram documento (eram o maior consumidor de espaço no plano
   * gratuito), mas são a melhor fonte de duas coisas: a composição atual do
   * grupo e o vínculo `@lid`→telefone de quem nunca falou.
   */
  private countSnapshot(
    batch: CounterBatch,
    event: CapturedEvent,
    payload: GroupSnapshotPayload,
  ): void {
    const groupId = event.group?.id;
    // Um snapshot vazio no boot é um artefato de sincronização, não um grupo
    // que esvaziou — sobrescrever a lista com ele apagaria os participantes.
    if (!groupId || payload.participants.length === 0) return;

    const group = batch.group(groupId, payload.subject ?? event.group?.name ?? null);
    group.eventAt(new Date(event.capturedAt));

    for (const participant of payload.participants) {
      const identity = resolveIdentity(participant);
      if (!identity) continue;
      batch
        .person(identity)
        .linkGroup(groupId, { active: true, isAdmin: participant.isAdmin })
        .seenAt(new Date(event.capturedAt));
    }
  }

  private async flushCounters(batch: CounterBatch): Promise<void> {
    if (batch.isEmpty()) return;

    // As pessoas vêm primeiro e sozinhas: os vínculos com grupos são
    // atualizações dentro de um array, e o elemento precisa existir antes.
    await this.bulk(COLLECTIONS.people, batch.peopleOps());
    await this.writeGroupLinks(batch.groupLinks());

    await Promise.all([
      this.bulk(COLLECTIONS.groups, batch.groupOps()),
      this.bulk(COLLECTIONS.activityDaily, batch.dailyOps()),
      this.bulk(COLLECTIONS.messages, batch.messageRollupOps()),
    ]);
  }

  /**
   * Grava `people.groups[]` em dois passos: primeiro insere o vínculo que
   * ainda não existe (com um filtro que torna o `$push` idempotente), depois
   * aplica as flags de quem já está lá. Os contadores por grupo desse array
   * ficam para o recálculo, que os soma de `activity_daily`.
   */
  private async writeGroupLinks(links: GroupLink[]): Promise<void> {
    if (links.length === 0) return;
    const collection = await this.store.collection<PersonDoc>(COLLECTIONS.people);
    if (!collection) return;

    const inserts: AnyBulkWriteOperation<PersonDoc>[] = links.map((link) => ({
      updateOne: {
        // O `$ne` também casa quando o array não existe — cobre a primeira vez.
        filter: { _id: link.personId, 'groups.groupId': { $ne: link.groupId } },
        update: {
          $push: {
            groups: {
              groupId: link.groupId,
              active: link.active ?? true,
              isAdmin: link.isAdmin ?? false,
              joinedAt: null,
              leftAt: null,
              messagesSent: 0,
              reactionsGiven: 0,
              lastMessageAt: null,
            },
          },
        },
      },
    })) as AnyBulkWriteOperation<PersonDoc>[];
    await collection.bulkWrite(inserts, { ordered: false });

    const updates: AnyBulkWriteOperation<PersonDoc>[] = [];
    for (const link of links) {
      const set: Document = {};
      if (link.active !== undefined) set['groups.$[g].active'] = link.active;
      if (link.isAdmin !== undefined) set['groups.$[g].isAdmin'] = link.isAdmin;
      // Datas só vêm de evento de entrada/saída, que sabe a hora do movimento.
      // Um snapshot diz que a pessoa *está* no grupo, não desde quando —
      // carimbar a data nele reescreveria `joinedAt` a cada varredura.
      if (link.joinedAt) set['groups.$[g].joinedAt'] = link.joinedAt;
      if (link.leftAt) set['groups.$[g].leftAt'] = link.leftAt;
      if (Object.keys(set).length === 0) continue;
      updates.push({
        updateOne: {
          filter: { _id: link.personId },
          update: { $set: set },
          arrayFilters: [{ 'g.groupId': link.groupId }],
        },
      } as AnyBulkWriteOperation<PersonDoc>);
    }
    if (updates.length) await collection.bulkWrite(updates, { ordered: false });
  }

  private async bulk<T extends Document>(
    name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
    ops: AnyBulkWriteOperation<T>[],
  ): Promise<void> {
    if (ops.length === 0) return;
    const collection = await this.store.collection<T>(name);
    if (!collection) return;
    await collection.bulkWrite(ops, { ordered: false });
  }

  /**
   * Cópia crua do evento. Dois tipos ficam de fora, por volume:
   *
   * - `group_snapshot`: um grupo de 830 membros gera ~100 KB por snapshot e
   *   vários por dia, o que sozinho comeria mais espaço que todas as mensagens.
   * - `message_read`: é o evento de maior cardinalidade do projeto — uma
   *   mensagem sua num grupo de 250 pessoas gera até 250 deles. E, ao
   *   contrário de uma mensagem, ele não tem conteúdo a preservar: o documento
   *   em `message_reads` já guarda tudo que existe. O JSONL local continua
   *   com a cópia integral.
   */
  private async writeRawLog(events: CapturedEvent[]): Promise<void> {
    if (!this.rawLog) return;
    const loggable = events.filter(
      (e) => e.type !== 'group_snapshot' && e.type !== 'message_read',
    );
    if (loggable.length === 0) return;

    const collection = await this.store.collection<RawEventDoc>(COLLECTIONS.events);
    if (!collection) return;

    const seen = new Set<string>();
    const ops: AnyBulkWriteOperation<RawEventDoc>[] = [];
    for (const event of loggable) {
      const id = rawEventId(event);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              type: event.type,
              groupId: event.group?.id ?? null,
              capturedAt: new Date(event.capturedAt),
              event,
            },
          },
          upsert: true,
        },
      } as AnyBulkWriteOperation<RawEventDoc>);
    }
    if (ops.length) await collection.bulkWrite(ops, { ordered: false });
  }
}

/**
 * `_id` determinístico do log bruto. Deriva do conteúdo, nunca do `eventId`
 * (que é um UUID novo a cada emissão), para que reimportar não duplique.
 */
export function rawEventId(event: CapturedEvent): string | null {
  const group = event.group?.id ?? '_';
  switch (event.type) {
    case 'message':
      return `msg|${event.payload.messageId}`;
    case 'reaction_added':
    case 'reaction_removed':
      return `rx|${event.type}|${event.payload.targetMessageId}|${event.actor?.id ?? '_'}|${
        event.payload.emoji
      }|${event.payload.reactedAt ?? event.capturedAt}`;
    // Sem o horário na chave de propósito: a mesma pessoa lendo a mesma
    // mensagem é sempre o mesmo fato, e o `readAt` pode variar entre as rotas.
    case 'message_read':
      return `rd|${event.payload.targetMessageId}|${event.actor?.id ?? '_'}`;
    case 'participants_changed':
      return `pc|${group}|${event.payload.action}|${event.payload.who
        .map((w) => w.id)
        .join(',')}|${event.capturedAt}`;
    case 'session_state':
      return `st|${event.payload.state}|${event.capturedAt}`;
    default:
      return null;
  }
}
