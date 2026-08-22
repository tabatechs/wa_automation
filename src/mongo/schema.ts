/**
 * Formato dos documentos no MongoDB e a lista de índices.
 *
 * Duas coleções são as de leitura — `people` e `groups`, uma pessoa e um grupo
 * por documento. As demais são o material de onde elas saem.
 *
 * A regra que atravessa tudo: **todo `_id` é determinístico**. O `eventId` dos
 * eventos é um UUID novo a cada emissão e não serve de chave — reimportar o
 * JSONL duplicaria tudo. Derivando o `_id` do conteúdo, toda escrita vira um
 * upsert idempotente e o mesmo evento pode ser processado quantas vezes for.
 */

import type { IndexDescription } from 'mongodb';

/** Nomes lógicos; o sufixo de ambiente (`_teste`) é aplicado em `client.ts`. */
export const COLLECTIONS = {
  people: 'people',
  groups: 'groups',
  messages: 'messages',
  reactions: 'reactions',
  pollVotes: 'poll_votes',
  messageReads: 'message_reads',
  memberEvents: 'member_events',
  activityDaily: 'activity_daily',
  events: 'events',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// ---------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------

/** Participação de uma pessoa num grupo específico. */
export interface PersonGroupLink {
  groupId: string;
  /** Ainda é membro. */
  active: boolean;
  isAdmin: boolean;
  joinedAt: Date | null;
  leftAt: Date | null;
  messagesSent: number;
  reactionsGiven: number;
  lastMessageAt: Date | null;
}

/**
 * De onde veio o documento de uma pessoa.
 *
 * `whatsapp` é quem o monitor observou — falou, reagiu ou apareceu na lista de
 * participantes. `external` é registro criado por outra ferramenta (importação
 * de planilha) para um número que ainda não foi visto em grupo nenhum: existe
 * para ser pesquisável, mas **não é uma pessoa observada** e não pode entrar em
 * nenhuma métrica. Documento antigo não tem o campo — por isso todo filtro usa
 * `$ne: 'external'`, e não `$eq: 'whatsapp'`.
 */
export type PersonOrigin = 'whatsapp' | 'external';

export const EXTERNAL_ORIGIN: PersonOrigin = 'external';

/** Filtro que exclui os registros externos. Use em tudo que varre `people`. */
export const OBSERVED_ONLY = { origin: { $ne: EXTERNAL_ORIGIN } } as const;

/**
 * Um documento de pessoa.
 *
 * **Todo campo aqui é camelCase, sem `_`, e isso não é só estilo.** O painel de
 * planilhas (repositório `tabatech_monitor`) grava campos seus neste mesmo
 * documento, nomeados `<slugDaPlanilha>_<slugDaColuna>` — e o `_` é a fronteira
 * que torna a colisão impossível. Acrescentar aqui um campo com `_` no nome
 * derruba essa garantia e abre caminho para uma planilha sobrescrever métrica
 * em silêncio. Se algum dia for inevitável, avise o outro lado antes.
 */
export interface PersonDoc {
  /** Dígitos do E.164 (`5511988812345`) ou `lid:<id>` enquanto o número não aparece. */
  _id: string;
  /** Ausente nos documentos anteriores a 22/08/2026; ausente = observado. */
  origin?: PersonOrigin;
  phone: string | null;
  ddd: string | null;
  isInternational: boolean;
  isMobile: boolean | null;
  name: string | null;
  nameSource: string | null;
  /** Todos os ids do WhatsApp já vistos para esta pessoa (`@lid` e `@c.us`). */
  aliases: string[];
  /** `_id`s provisórios absorvidos por este documento, para auditoria. */
  mergedFrom?: string[];

  groups: PersonGroupLink[];

  // --- volume (cru) ---
  messagesSent: number;
  mediaSent: number;
  charsSent: number;
  linksShared: number;

  // --- conversa (cru) ---
  repliesSent: number;
  repliesReceived: number;
  mentionsMade: number;
  mentionsReceived: number;
  conversationsStarted: number;

  // --- reações (cru) ---
  reactionsGiven: number;
  reactionsReceived: number;
  emojisUsed: string[];

  // --- enquetes (cru) ---
  pollVotesCast: number;
  pollsCreated: number;

  // --- leitura (cru) ---
  /**
   * Quantas mensagens SUAS esta pessoa abriu. Só existe para mensagens da
   * própria conta: o WhatsApp não informa quem leu a mensagem de terceiros.
   */
  messagesRead: number;

  // --- ritmo ---
  // Objeto, não array: `$inc` em `hourHistogram.14` cria o campo sozinho, ao
  // passo que inicializar um array de 24 zeros no mesmo update entraria em
  // conflito de caminho com o próprio `$inc`. Chaves ausentes valem zero.
  hourHistogram: Record<string, number>; // hora local de São Paulo
  weekdayHistogram: Record<string, number>; // domingo = 0
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  lastMessageAt: Date | null;

  // --- campos derivados (preenchidos pelo recálculo agendado) ---
  /**
   * Espelhos legíveis dos `Date` acima, em ISO com o fuso de São Paulo.
   *
   * O `Date` do BSON guarda instante e não fuso, então o Compass e o Atlas
   * mostram tudo em UTC — três horas à frente, o que faz parecer horário
   * errado. Filtre e ordene pelos `Date`; leia estes.
   */
  lastMessageAtLocal?: string | null;
  lastSeenAtLocal?: string | null;
  groupCount?: number;
  activeGroupCount?: number;
  avgMessageLength?: number;
  activeDays?: number;
  activeDaysLast30?: number;
  tenureDays?: number;
  daysSinceLastMessage?: number | null;
  currentStreakDays?: number;
  longestStreakDays?: number;
  distinctPeopleReactedTo?: number;
  distinctPeopleWhoReacted?: number;
  topEmojis?: Array<{ emoji: string; count: number }>;
  pollsAvailable?: number;
  pollResponseRate?: number | null;
  reactionsReceivedPerMessage?: number;
  repliesReceivedPerMessage?: number;
  messagesPerActiveDay?: number;
  messagesLast7d?: number;
  messagesPrev7d?: number;
  trend7d?: 'rising' | 'stable' | 'falling';
  isLurker?: boolean;
  isDormant?: boolean;
  isObserver?: boolean;
  isAdminSomewhere?: boolean;
  isMultiGroup?: boolean;
  messagesWithReaction?: number;
  engagementScore?: number;
  tier?: PersonTier;

  updatedAt: Date;
}

export type PersonTier =
  | 'champion'
  | 'active'
  | 'occasional'
  | 'observer'
  | 'lurker'
  | 'dormant';

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export interface GroupParticipant {
  personId: string;
  name: string | null;
  isAdmin: boolean;
  active: boolean;
}

export interface GroupDoc {
  /** O id do WhatsApp, `120363000000000000@g.us`. */
  _id: string;
  subject: string | null;
  /** Legado: rótulo local da whitelist, que hoje guarda só ids. Sempre null. */
  label: string | null;
  description: string | null;
  owner: string | null;

  memberCount: number;
  participants: GroupParticipant[];
  admins: string[];
  joins: number;
  leaves: number;

  totalMessages: number;
  totalReactions: number;
  totalPolls: number;
  mediaMessages: number;
  messagesWithReaction: number;
  messagesWithReply: number;
  /** Leituras de mensagens próprias, somadas. Zero em grupo onde você não posta. */
  totalReads: number;

  hourHistogram: Record<string, number>;
  weekdayHistogram: Record<string, number>;
  firstEventAt: Date | null;
  /** Qualquer evento, inclusive os que só têm o horário da captura. */
  lastEventAt: Date | null;
  /** Vem do `sentAt` da mensagem, não do momento em que a capturamos. */
  lastMessageAt: Date | null;

  // --- campos derivados (recálculo agendado) ---
  /** Espelhos legíveis dos `Date` acima — ver `PersonDoc.lastMessageAtLocal`. */
  lastMessageAtLocal?: string | null;
  lastEventAtLocal?: string | null;
  activeMembers7d?: number;
  activeMembers30d?: number;
  participationRate?: number;
  silentMemberCount?: number;
  reactionRate?: number;
  avgReactionsPerMessage?: number;
  replyRate?: number;
  pollResponseRate?: number | null;
  mediaShare?: number;
  top10SharePct?: number;
  giniMessages?: number;
  topPosters?: GroupRanking[];
  topReactors?: GroupRanking[];
  topReceivers?: GroupRanking[];
  peakHours?: number[];
  /** `{ "11": 340, "21": 88, "internacional": 4 }` */
  dddDistribution?: Record<string, number>;
  netGrowth30d?: number;
  churnRate30d?: number;
  daysSinceLastMessage?: number | null;
  messagesLast7d?: number;
  messagesPrev7d?: number;
  trend7d?: 'rising' | 'stable' | 'falling';

  updatedAt: Date;
}

export interface GroupRanking {
  personId: string;
  name: string | null;
  count: number;
}

// ---------------------------------------------------------------------------
// coleções de domínio
// ---------------------------------------------------------------------------

export interface MessageDoc {
  /** O `messageId` do WhatsApp, que já embute grupo e autor. */
  _id: string;
  groupId: string;
  authorId: string | null;
  authorActorId: string | null;
  sentAt: Date | null;
  capturedAt: Date;
  messageType: string;
  body: string | null;
  caption: string | null;
  len: number;
  wordCount: number;
  linkCount: number;
  isMedia: boolean;
  mimetype: string | null;
  fromMe: boolean;
  backfill: boolean;
  quotedMsgId: string | null;
  mentionedIds: string[];
  hour: number | null;
  weekday: number | null;
  isPoll: boolean;
  pollOptions: string[] | null;
  /** Rollups mantidos por reações/respostas — nunca sobrescritos pelo evento. */
  reactionsCount: number;
  distinctReactors: number;
  repliesCount: number;
  /** Quantas pessoas abriram esta mensagem. Só faz sentido quando `fromMe`. */
  readsCount: number;
}

export interface ReactionDoc {
  /** `${targetMessageId}|${personId}|${emoji}` */
  _id: string;
  groupId: string;
  targetMessageId: string;
  /** Autor da mensagem reagida; null enquanto a mensagem não chegou. */
  targetAuthorId: string | null;
  personId: string;
  emoji: string;
  active: boolean;
  addedAt: Date | null;
  removedAt: Date | null;
}

/**
 * Uma pessoa abriu uma mensagem sua.
 *
 * Chave `${targetMessageId}|${actorKey}`: um registro por pessoa por mensagem,
 * reprocessável sem duplicar. Não há "leitura removida" — no WhatsApp ler é
 * irreversível, então não existe o par `active/removedAt` das reações.
 */
export interface MessageReadDoc {
  _id: string;
  groupId: string;
  targetMessageId: string;
  personId: string;
  readAt: Date | null;
}

export interface PollVoteDoc {
  /** `${pollMessageId}|${personId}` — um voto por pessoa, substituível. */
  _id: string;
  groupId: string;
  pollMessageId: string;
  personId: string;
  selectedOptions: string[];
  votedAt: Date | null;
}

export interface MemberEventDoc {
  /** Hash de `(groupId, action, whoId, capturedAt)`. */
  _id: string;
  groupId: string;
  action: string;
  rawAction: string;
  /** Quem entrou/saiu/foi promovido. */
  personId: string | null;
  /** Quem executou a ação. */
  byPersonId: string | null;
  detectedOnResume: boolean;
  capturedAt: Date;
}

export interface ActivityDailyDoc {
  /** `${groupId}|${personId ?? '_all'}|${YYYY-MM-DD}` */
  _id: string;
  groupId: string;
  /** null = linha agregada do grupo naquele dia. */
  personId: string | null;
  date: string;
  messages: number;
  mediaMessages: number;
  chars: number;
  reactionsGiven: number;
  reactionsReceived: number;
  repliesSent: number;
  pollVotes: number;
  messagesRead: number;
}

/** Cópia fiel do evento do JSONL, quando `MONGO_RAW_LOG` está ligado. */
export interface RawEventDoc {
  _id: string;
  type: string;
  groupId: string | null;
  capturedAt: Date;
  event: unknown;
}

// ---------------------------------------------------------------------------
// índices
// ---------------------------------------------------------------------------

/**
 * `quotedMsgId` é esparso de propósito: a grande maioria das mensagens não cita
 * ninguém, e o id do WhatsApp é uma string de ~80 caracteres — indexar os nulos
 * custaria uma fatia relevante dos 512 MB do plano gratuito.
 */
export const INDEXES: Record<CollectionName, IndexDescription[]> = {
  [COLLECTIONS.people]: [
    { key: { aliases: 1 } },
    { key: { 'groups.groupId': 1 } },
    { key: { engagementScore: -1 } },
    { key: { lastMessageAt: -1 } },
  ],
  [COLLECTIONS.groups]: [{ key: { lastMessageAt: -1 } }],
  [COLLECTIONS.messages]: [
    { key: { groupId: 1, sentAt: -1 } },
    { key: { authorId: 1, sentAt: -1 } },
    { key: { quotedMsgId: 1 }, sparse: true },
  ],
  [COLLECTIONS.reactions]: [
    { key: { targetMessageId: 1 } },
    { key: { personId: 1, active: 1 } },
    { key: { groupId: 1, active: 1 } },
  ],
  [COLLECTIONS.pollVotes]: [
    { key: { pollMessageId: 1 } },
    { key: { personId: 1 } },
  ],
  [COLLECTIONS.messageReads]: [
    { key: { targetMessageId: 1 } },
    { key: { personId: 1 } },
    { key: { groupId: 1, readAt: -1 } },
  ],
  [COLLECTIONS.memberEvents]: [{ key: { groupId: 1, capturedAt: -1 } }],
  [COLLECTIONS.activityDaily]: [
    { key: { groupId: 1, date: -1 } },
    { key: { personId: 1, date: -1 } },
  ],
  [COLLECTIONS.events]: [{ key: { capturedAt: -1 } }, { key: { type: 1 } }],
};

// ---------------------------------------------------------------------------
// valores iniciais
// ---------------------------------------------------------------------------

/**
 * Zeros de referência, usados pelo recálculo para normalizar documentos.
 *
 * O caminho quente **não** os aplica: `$inc` já cria o campo que falta, e um
 * `$setOnInsert` no mesmo campo que o `$inc` seria rejeitado pelo Mongo como
 * conflito de caminho. Quem garante que todo contador existe é o recálculo.
 */
export function newPersonCounters(): Omit<
  PersonDoc,
  '_id' | 'phone' | 'ddd' | 'isInternational' | 'isMobile' | 'name' | 'nameSource' | 'aliases' | 'groups' | 'updatedAt'
> {
  return {
    messagesSent: 0,
    mediaSent: 0,
    charsSent: 0,
    linksShared: 0,
    repliesSent: 0,
    repliesReceived: 0,
    mentionsMade: 0,
    mentionsReceived: 0,
    conversationsStarted: 0,
    reactionsGiven: 0,
    reactionsReceived: 0,
    emojisUsed: [],
    pollVotesCast: 0,
    pollsCreated: 0,
    messagesRead: 0,
    hourHistogram: {},
    weekdayHistogram: {},
    firstSeenAt: null,
    lastSeenAt: null,
    lastMessageAt: null,
  };
}

export function newGroupCounters(): Pick<
  GroupDoc,
  | 'memberCount' | 'participants' | 'admins' | 'joins' | 'leaves'
  | 'totalMessages' | 'totalReactions' | 'totalPolls' | 'mediaMessages'
  | 'messagesWithReaction' | 'messagesWithReply' | 'totalReads'
  | 'hourHistogram' | 'weekdayHistogram'
  | 'firstEventAt' | 'lastEventAt' | 'lastMessageAt'
> {
  return {
    memberCount: 0,
    participants: [],
    admins: [],
    joins: 0,
    leaves: 0,
    totalMessages: 0,
    totalReactions: 0,
    totalPolls: 0,
    mediaMessages: 0,
    messagesWithReaction: 0,
    messagesWithReply: 0,
    totalReads: 0,
    hourHistogram: {},
    weekdayHistogram: {},
    firstEventAt: null,
    lastEventAt: null,
    lastMessageAt: null,
  };
}
