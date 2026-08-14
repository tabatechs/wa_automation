/**
 * Recálculo das métricas caras.
 *
 * O caminho quente (`ingest.ts`) mantém vivo o que é barato: contadores do que
 * a pessoa fez, na hora em que ela faz. Aqui fica tudo que precisa varrer o
 * conjunto inteiro — e tudo que depende de comparar pessoas entre si.
 *
 * Três diferenças de natureza em relação ao caminho quente:
 *
 *   - Aqui é `$set`, não `$inc`. Todo valor é recalculado do zero a partir de
 *     `messages`/`reactions`, então rodar duas vezes seguidas dá o mesmo
 *     resultado — não há como derivar.
 *   - Aqui é que se contabiliza o que a pessoa **recebeu** (reações, respostas,
 *     menções). No caminho quente isso exigiria saber o autor de uma mensagem
 *     que muitas vezes ainda nem chegou ao banco, porque o backfill lê o
 *     histórico fora de ordem. Somando no fim, a ordem de chegada não importa.
 *   - Aqui é que os `lid:` provisórios se fundem com a pessoa de telefone
 *     conhecido, quando o vínculo finalmente aparece.
 */

import type { Db, Document } from 'mongodb';
import { createLogger } from '../util/logger';
import { dateKeyDaysAgo, daysBetween } from '../util/time';
import { PENDING_PREFIX } from './identity';
import { SCORING, tierOf } from './scoring';
import type { MongoStore } from './client';
import {
  COLLECTIONS,
  newGroupCounters,
  newPersonCounters,
  type GroupDoc,
  type PersonDoc,
} from './schema';

const log = createLogger('mongo:metrics');

const TZ = 'America/Sao_Paulo';

export interface RefreshStats {
  merged: number;
  people: number;
  groups: number;
  durationMs: number;
}

export class MetricsBuilder {
  constructor(private readonly store: MongoStore) {}

  private col(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS]): string {
    return this.store.name(name);
  }

  /**
   * Passada padrão. `full` também reconta os contadores do caminho quente a
   * partir de `messages`/`reactions` — é a rede de segurança contra qualquer
   * deriva, e o caminho para quando a definição de uma métrica muda.
   */
  async refresh(options: { full?: boolean } = {}): Promise<RefreshStats> {
    const started = Date.now();
    const stats: RefreshStats = { merged: 0, people: 0, groups: 0, durationMs: 0 };

    const db = await this.store.connect();
    if (!db) {
      log.warn('sem conexão com o MongoDB; recálculo ignorado');
      return stats;
    }

    try {
      stats.merged = await this.mergePendingIdentities(db);
      await this.rebuildMessageRollups(db);
      await this.rebuildActivityDaily(db);
      if (options.full) await this.recountHotCounters(db);
      stats.people = await this.refreshPeople(db);
      stats.groups = await this.refreshGroups(db);
      await this.scoreAndTier(db);
    } catch (error) {
      log.error('falha no recálculo', error);
    }

    stats.durationMs = Date.now() - started;
    log.info('recálculo concluído', {
      pessoas: stats.people,
      grupos: stats.groups,
      fusoes: stats.merged,
      ms: stats.durationMs,
    });
    return stats;
  }

  // -------------------------------------------------------------------------
  // 1. fusão de identidades provisórias
  // -------------------------------------------------------------------------

  /**
   * Um `lid:` provisório e uma pessoa de telefone conhecido são a mesma pessoa
   * quando compartilham algum alias. Quando isso aparece, o provisório é
   * drenado para dentro do definitivo e some.
   *
   * Repontar `messages`/`reactions`/`member_events` é obrigatório: o recálculo
   * deriva os contadores dessas coleções, então deixar o `authorId` antigo
   * faria o provisório renascer na passada seguinte.
   */
  private async mergePendingIdentities(db: Db): Promise<number> {
    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));
    const pendingPattern = `^${PENDING_PREFIX}`;
    const pending = await people.find({ _id: { $regex: pendingPattern } }).toArray();
    if (pending.length === 0) return 0;

    let merged = 0;
    for (const source of pending) {
      const aliases = source.aliases ?? [];
      if (aliases.length === 0) continue;

      // O alvo tem de ser uma pessoa já identificada por telefone: fundir dois
      // provisórios entre si não resolveria nada e poderia encadear fusões.
      const target = await people.findOne({
        _id: { $ne: source._id, $not: { $regex: pendingPattern } },
        aliases: { $in: aliases },
      });
      if (!target) continue;

      await this.drainPerson(db, source, target);
      merged += 1;
    }

    if (merged) log.info('identidades provisórias fundidas', { total: merged });
    return merged;
  }

  private async drainPerson(db: Db, source: PersonDoc, target: PersonDoc): Promise<void> {
    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));

    // Contadores são somados; o recálculo logo em seguida reescreve os
    // derivados de qualquer jeito, mas os brutos precisam sobreviver à fusão.
    const inc: Record<string, number> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number' && key !== '__v') inc[key] = value;
    }
    for (const [bucket, value] of Object.entries(source.hourHistogram ?? {})) {
      inc[`hourHistogram.${bucket}`] = value;
    }
    for (const [bucket, value] of Object.entries(source.weekdayHistogram ?? {})) {
      inc[`weekdayHistogram.${bucket}`] = value;
    }

    const update: Document = {
      $addToSet: {
        aliases: { $each: source.aliases ?? [] },
        emojisUsed: { $each: source.emojisUsed ?? [] },
        mergedFrom: source._id,
      },
      $set: { updatedAt: new Date() },
    };
    if (Object.keys(inc).length) update.$inc = inc;
    if (source.firstSeenAt) update.$min = { firstSeenAt: source.firstSeenAt };
    const max: Document = {};
    if (source.lastSeenAt) max.lastSeenAt = source.lastSeenAt;
    if (source.lastMessageAt) max.lastMessageAt = source.lastMessageAt;
    if (Object.keys(max).length) update.$max = max;

    await people.updateOne({ _id: target._id }, update);

    // Vínculos de grupo que o alvo ainda não tem.
    const known = new Set((target.groups ?? []).map((g) => g.groupId));
    const missing = (source.groups ?? []).filter((g) => !known.has(g.groupId));
    if (missing.length) {
      await people.updateOne({ _id: target._id }, { $push: { groups: { $each: missing } } });
    }

    await Promise.all([
      db.collection(this.col(COLLECTIONS.messages))
        .updateMany({ authorId: source._id }, { $set: { authorId: target._id } }),
      db.collection(this.col(COLLECTIONS.reactions))
        .updateMany({ personId: source._id }, { $set: { personId: target._id } }),
      db.collection(this.col(COLLECTIONS.memberEvents))
        .updateMany({ personId: source._id }, { $set: { personId: target._id } }),
      db.collection(this.col(COLLECTIONS.memberEvents))
        .updateMany({ byPersonId: source._id }, { $set: { byPersonId: target._id } }),
      db.collection(this.col(COLLECTIONS.pollVotes))
        .updateMany({ personId: source._id }, { $set: { personId: target._id } }),
      db.collection(this.col(COLLECTIONS.messageReads))
        .updateMany({ personId: source._id }, { $set: { personId: target._id } }),
      // `activity_daily` embute o personId no `_id`; em vez de repontar linha a
      // linha, as linhas antigas são apagadas e a série é reconstruída logo
      // abaixo, a partir de `messages`.
      db.collection(this.col(COLLECTIONS.activityDaily)).deleteMany({ personId: source._id }),
    ]);

    await people.deleteOne({ _id: source._id });
    log.debug('pessoa fundida', { de: source._id, para: target._id });
  }

  // -------------------------------------------------------------------------
  // 2. rollups das mensagens
  // -------------------------------------------------------------------------

  /**
   * Reescreve `messages.reactionsCount` / `distinctReactors` / `repliesCount`
   * contando direto da fonte.
   *
   * O caminho quente incrementa esses rollups quando pode, mas não sempre
   * consegue: uma reação lida pelo backfill chega antes da mensagem que ela
   * reage, e o incremento cai no vazio porque o documento alvo ainda não
   * existe. Como `reactionsReceived` de cada pessoa é somado a partir daqui,
   * confiar só no incremento subcontaria justamente as mensagens mais antigas.
   * Contar de `reactions` e de `messages.quotedMsgId` não tem esse problema —
   * a ordem de chegada deixa de importar.
   */
  private async rebuildMessageRollups(db: Db): Promise<void> {
    const target = this.col(COLLECTIONS.messages);

    // Zera antes: uma mensagem que perdeu todas as reações precisa cair para
    // zero, e o `$merge` só toca em quem aparece no resultado.
    await db.collection(target).updateMany(
      {
        $or: [
          { reactionsCount: { $gt: 0 } },
          { repliesCount: { $gt: 0 } },
          { readsCount: { $gt: 0 } },
        ],
      },
      { $set: { reactionsCount: 0, distinctReactors: 0, repliesCount: 0, readsCount: 0 } },
    );

    await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate([
        { $match: { active: true } },
        {
          $group: {
            _id: '$targetMessageId',
            reactionsCount: { $sum: 1 },
            reactors: { $addToSet: '$personId' },
          },
        },
        { $project: { reactionsCount: 1, distinctReactors: { $size: '$reactors' } } },
        // `discard`: uma reação a mensagem que nunca foi capturada (anterior à
        // janela de backfill) não pode inventar um documento de mensagem.
        { $merge: { into: target, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } },
      ])
      .toArray();

    await db
      .collection(target)
      .aggregate([
        { $match: { quotedMsgId: { $ne: null } } },
        { $group: { _id: '$quotedMsgId', repliesCount: { $sum: 1 } } },
        { $merge: { into: target, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } },
      ])
      .toArray();

    // Leituras: mesma lógica das reações. A confirmação de leitura de uma
    // mensagem própria costuma chegar depois dela, mas um restart pode inverter
    // a ordem — contar da fonte torna isso irrelevante.
    await db
      .collection(this.col(COLLECTIONS.messageReads))
      .aggregate([
        { $group: { _id: '$targetMessageId', readsCount: { $sum: 1 } } },
        { $merge: { into: target, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } },
      ])
      .toArray();
  }

  // -------------------------------------------------------------------------
  // 3. série temporal
  // -------------------------------------------------------------------------

  /**
   * Reconstrói `activity_daily` a partir de `messages` e `reactions`. O caminho
   * quente mantém a série fresca entre uma passada e outra; aqui ela é
   * reescrita com o valor exato, o que também absorve fusões de identidade.
   */
  private async rebuildActivityDaily(db: Db): Promise<void> {
    await this.dropOrphanDailyRows(db);
    const dateExpr = { $dateToString: { format: '%Y-%m-%d', date: '$sentAt', timezone: TZ } };

    // Linhas por pessoa.
    await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate([
        { $match: { sentAt: { $ne: null }, authorId: { $ne: null } } },
        {
          $group: {
            _id: { groupId: '$groupId', personId: '$authorId', date: dateExpr },
            messages: { $sum: 1 },
            chars: { $sum: '$len' },
            mediaMessages: { $sum: { $cond: ['$isMedia', 1, 0] } },
            repliesSent: { $sum: { $cond: [{ $ne: ['$quotedMsgId', null] }, 1, 0] } },
          },
        },
        {
          $project: {
            _id: {
              $concat: ['$_id.groupId', '|', '$_id.personId', '|', '$_id.date'],
            },
            groupId: '$_id.groupId',
            personId: '$_id.personId',
            date: '$_id.date',
            messages: 1, chars: 1, mediaMessages: 1, repliesSent: 1,
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.activityDaily),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    // Linha agregada do grupo (personId: null).
    await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate([
        { $match: { sentAt: { $ne: null } } },
        {
          $group: {
            _id: { groupId: '$groupId', date: dateExpr },
            messages: { $sum: 1 },
            chars: { $sum: '$len' },
            mediaMessages: { $sum: { $cond: ['$isMedia', 1, 0] } },
            repliesSent: { $sum: { $cond: [{ $ne: ['$quotedMsgId', null] }, 1, 0] } },
            activeMembers: { $addToSet: '$authorId' },
          },
        },
        {
          $project: {
            _id: { $concat: ['$_id.groupId', '|_all|', '$_id.date'] },
            groupId: '$_id.groupId',
            personId: null,
            date: '$_id.date',
            messages: 1, chars: 1, mediaMessages: 1, repliesSent: 1,
            activeMembers: { $size: '$activeMembers' },
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.activityDaily),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    // Reações dadas, por pessoa e por grupo.
    const reactionDate = {
      $dateToString: { format: '%Y-%m-%d', date: '$addedAt', timezone: TZ },
    };
    await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate([
        { $match: { active: true, addedAt: { $ne: null } } },
        {
          $group: {
            _id: { groupId: '$groupId', personId: '$personId', date: reactionDate },
            reactionsGiven: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: { $concat: ['$_id.groupId', '|', '$_id.personId', '|', '$_id.date'] },
            groupId: '$_id.groupId',
            personId: '$_id.personId',
            date: '$_id.date',
            reactionsGiven: 1,
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.activityDaily),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    // Leituras de mensagens próprias, por pessoa e por grupo.
    const readDate = { $dateToString: { format: '%Y-%m-%d', date: '$readAt', timezone: TZ } };
    await db
      .collection(this.col(COLLECTIONS.messageReads))
      .aggregate([
        { $match: { readAt: { $ne: null } } },
        {
          $group: {
            _id: { groupId: '$groupId', personId: '$personId', date: readDate },
            messagesRead: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: { $concat: ['$_id.groupId', '|', '$_id.personId', '|', '$_id.date'] },
            groupId: '$_id.groupId',
            personId: '$_id.personId',
            date: '$_id.date',
            messagesRead: 1,
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.activityDaily),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();
  }

  /**
   * Apaga linhas da série que apontam para pessoas que não existem mais.
   *
   * O `_id` de `activity_daily` embute o `personId`, então uma fusão de
   * identidade não tem como repontar a linha: ela é apagada e reconstruída sob
   * o id novo. Sem esta limpeza, a linha antiga sobreviveria e a soma da série
   * ficaria maior que o total do grupo.
   */
  private async dropOrphanDailyRows(db: Db): Promise<void> {
    const daily = db.collection(this.col(COLLECTIONS.activityDaily));
    const ids = await daily.distinct('personId', { personId: { $ne: null } });
    if (ids.length === 0) return;

    const vivos = new Set(
      await db.collection(this.col(COLLECTIONS.people)).distinct('_id', { _id: { $in: ids } }),
    );
    const orfaos = ids.filter((id) => !vivos.has(id));
    if (orfaos.length === 0) return;

    const { deletedCount } = await daily.deleteMany({ personId: { $in: orfaos } });
    log.debug('linhas órfãs da série removidas', { pessoas: orfaos.length, linhas: deletedCount });
  }

  // -------------------------------------------------------------------------
  // 4. recontagem completa (só no --full)
  // -------------------------------------------------------------------------

  /**
   * Reescreve os contadores que o caminho quente mantém, recontando de
   * `messages` e `reactions`. Não deveria mudar nada — se mudar, houve deriva,
   * e este é o conserto.
   */
  private async recountHotCounters(db: Db): Promise<void> {
    log.info('recontagem completa dos contadores brutos');

    // Zera antes: quem parou de ter mensagens precisa cair para zero, e um
    // `$merge` só reescreve quem aparece no resultado.
    const zeros = newPersonCounters();
    await db.collection(this.col(COLLECTIONS.people)).updateMany({}, {
      $set: {
        messagesSent: 0, mediaSent: 0, charsSent: 0, linksShared: 0,
        repliesSent: 0, reactionsGiven: 0, pollVotesCast: 0, messagesRead: 0,
        hourHistogram: zeros.hourHistogram, weekdayHistogram: zeros.weekdayHistogram,
      },
    });

    await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate([
        { $match: { authorId: { $ne: null } } },
        {
          $group: {
            _id: '$authorId',
            messagesSent: { $sum: 1 },
            mediaSent: { $sum: { $cond: ['$isMedia', 1, 0] } },
            charsSent: { $sum: '$len' },
            linksShared: { $sum: '$linkCount' },
            repliesSent: { $sum: { $cond: [{ $ne: ['$quotedMsgId', null] }, 1, 0] } },
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate([
        { $match: { active: true } },
        { $group: { _id: '$personId', reactionsGiven: { $sum: 1 } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    await db
      .collection(this.col(COLLECTIONS.messageReads))
      .aggregate([
        { $group: { _id: '$personId', messagesRead: { $sum: 1 } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    const groupZeros = newGroupCounters();
    await db.collection(this.col(COLLECTIONS.groups)).updateMany({}, {
      $set: {
        totalMessages: 0, mediaMessages: 0, totalReactions: 0, totalReads: 0,
        hourHistogram: groupZeros.hourHistogram, weekdayHistogram: groupZeros.weekdayHistogram,
      },
    });

    await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate([
        {
          $group: {
            _id: '$groupId',
            totalMessages: { $sum: 1 },
            mediaMessages: { $sum: { $cond: ['$isMedia', 1, 0] } },
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.groups),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate([
        { $match: { active: true } },
        { $group: { _id: '$groupId', totalReactions: { $sum: 1 } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.groups),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    await db
      .collection(this.col(COLLECTIONS.messageReads))
      .aggregate([
        { $group: { _id: '$groupId', totalReads: { $sum: 1 } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.groups),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ])
      .toArray();

    await this.rebuildHistograms(db);
  }

  /**
   * Reconstrói os histogramas de hora e dia da semana a partir de `messages`.
   *
   * Precisa existir porque a recontagem zera os histogramas, e as agregações de
   * contadores acima não os reescrevem — sem isto, `peakHours` sairia vazio
   * depois de todo `--full`.
   */
  private async rebuildHistograms(db: Db): Promise<void> {
    const buckets: Array<{ campo: 'hour' | 'weekday'; destino: string }> = [
      { campo: 'hour', destino: 'hourHistogram' },
      { campo: 'weekday', destino: 'weekdayHistogram' },
    ];

    for (const { campo, destino } of buckets) {
      for (const [chave, alvo] of [
        ['$authorId', this.col(COLLECTIONS.people)],
        ['$groupId', this.col(COLLECTIONS.groups)],
      ] as const) {
        await db
          .collection(this.col(COLLECTIONS.messages))
          .aggregate([
            { $match: { [campo]: { $ne: null }, ...(chave === '$authorId' ? { authorId: { $ne: null } } : {}) } },
            { $group: { _id: { dono: chave, bucket: `$${campo}` }, total: { $sum: 1 } } },
            {
              $group: {
                _id: '$_id.dono',
                // `$arrayToObject` monta o histograma como objeto — a mesma
                // forma que o `$inc` do caminho quente produz.
                pares: { $push: { k: { $toString: '$_id.bucket' }, v: '$total' } },
              },
            },
            { $project: { [destino]: { $arrayToObject: '$pares' } } },
            { $merge: { into: alvo, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } },
          ])
          .toArray();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. derivados por pessoa
  // -------------------------------------------------------------------------

  private async refreshPeople(db: Db): Promise<number> {
    const messages = db.collection(this.col(COLLECTIONS.messages));
    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));

    const day7 = dateKeyDaysAgo(7);
    const day14 = dateKeyDaysAgo(14);
    const day30 = dateKeyDaysAgo(30);
    const dateExpr = { $dateToString: { format: '%Y-%m-%d', date: '$sentAt', timezone: TZ } };

    // --- o que a pessoa recebeu, e o ritmo dela ---
    await messages
      .aggregate([
        { $match: { authorId: { $ne: null } } },
        {
          $group: {
            _id: '$authorId',
            reactionsReceived: { $sum: { $ifNull: ['$reactionsCount', 0] } },
            repliesReceived: { $sum: { $ifNull: ['$repliesCount', 0] } },
            // Mensagens que provocaram alguma reação — a base da "ressonância".
            messagesWithReaction: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ['$reactionsCount', 0] }, 0] }, 1, 0] },
            },
            avgMessageLength: { $avg: '$len' },
            activeDaysSet: { $addToSet: dateExpr },
            activeDays30Set: {
              $addToSet: { $cond: [{ $gte: [dateExpr, day30] }, dateExpr, '$$REMOVE'] },
            },
            messagesLast7d: { $sum: { $cond: [{ $gte: [dateExpr, day7] }, 1, 0] } },
            messagesPrev7d: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: [dateExpr, day14] }, { $lt: [dateExpr, day7] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
        {
          $project: {
            reactionsReceived: 1, repliesReceived: 1, messagesWithReaction: 1,
            messagesLast7d: 1, messagesPrev7d: 1,
            avgMessageLength: { $round: [{ $ifNull: ['$avgMessageLength', 0] }, 1] },
            activeDays: { $size: '$activeDaysSet' },
            activeDaysLast30: { $size: '$activeDays30Set' },
            activeDates: '$activeDaysSet',
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    // --- menções recebidas: os ids mencionados são do WhatsApp, não personId ---
    await messages
      .aggregate([
        { $match: { mentionedIds: { $exists: true, $ne: [] } } },
        { $unwind: '$mentionedIds' },
        { $group: { _id: '$mentionedIds', mentions: { $sum: 1 } } },
        {
          $lookup: {
            from: this.col(COLLECTIONS.people),
            localField: '_id',
            foreignField: 'aliases',
            as: 'pessoa',
          },
        },
        { $unwind: '$pessoa' },
        { $group: { _id: '$pessoa._id', mentionsReceived: { $sum: '$mentions' } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    // --- alcance na rede: quantas pessoas diferentes reagiram a você ---
    await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate([
        { $match: { active: true } },
        {
          $lookup: {
            from: this.col(COLLECTIONS.messages),
            localField: 'targetMessageId',
            foreignField: '_id',
            as: 'alvo',
          },
        },
        { $unwind: '$alvo' },
        { $match: { 'alvo.authorId': { $ne: null } } },
        {
          $facet: {
            recebidas: [
              { $group: { _id: '$alvo.authorId', quem: { $addToSet: '$personId' } } },
              { $project: { distinctPeopleWhoReacted: { $size: '$quem' } } },
            ],
            dadas: [
              { $group: { _id: '$personId', quem: { $addToSet: '$alvo.authorId' } } },
              { $project: { distinctPeopleReactedTo: { $size: '$quem' } } },
            ],
          },
        },
        { $project: { todos: { $concatArrays: ['$recebidas', '$dadas'] } } },
        { $unwind: '$todos' },
        { $replaceRoot: { newRoot: '$todos' } },
        {
          $group: {
            _id: '$_id',
            distinctPeopleWhoReacted: { $max: '$distinctPeopleWhoReacted' },
            distinctPeopleReactedTo: { $max: '$distinctPeopleReactedTo' },
          },
        },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    // --- votos em enquete ---
    await db
      .collection(this.col(COLLECTIONS.pollVotes))
      .aggregate([
        { $group: { _id: '$personId', pollVotesCast: { $sum: 1 } } },
        {
          $merge: {
            into: this.col(COLLECTIONS.people),
            on: '_id',
            whenMatched: 'merge',
            whenNotMatched: 'discard',
          },
        },
      ])
      .toArray();

    // --- contadores por grupo dentro de people.groups[] ---
    await this.refreshPersonGroupCounters(db);

    // --- o que é mais simples calcular em JS que em pipeline ---
    return this.finalizePeople(people);
  }

  /** Preenche `people.groups[].messagesSent` etc. a partir de `activity_daily`. */
  private async refreshPersonGroupCounters(db: Db): Promise<void> {
    const rows = await db
      .collection(this.col(COLLECTIONS.activityDaily))
      .aggregate<{
        _id: { personId: string; groupId: string };
        messages: number;
        reactions: number;
        lastDate: string;
      }>([
        { $match: { personId: { $ne: null } } },
        {
          $group: {
            _id: { personId: '$personId', groupId: '$groupId' },
            messages: { $sum: { $ifNull: ['$messages', 0] } },
            reactions: { $sum: { $ifNull: ['$reactionsGiven', 0] } },
            lastDate: { $max: '$date' },
          },
        },
      ])
      .toArray();
    if (rows.length === 0) return;

    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));
    const ops = rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id.personId },
        update: {
          $set: {
            'groups.$[g].messagesSent': row.messages,
            'groups.$[g].reactionsGiven': row.reactions,
          },
        },
        arrayFilters: [{ 'g.groupId': row._id.groupId }],
      },
    }));
    await people.bulkWrite(ops as never, { ordered: false });
  }

  /**
   * Últimos derivados de cada pessoa: taxas, sequências de dias e os
   * sinalizadores que respondem "quem eu convido". Feito em JS porque depende
   * de percorrer as datas ativas em ordem, o que em pipeline sairia ilegível.
   */
  private async finalizePeople(
    people: import('mongodb').Collection<PersonDoc>,
  ): Promise<number> {
    const now = new Date();
    const cursor = people.find({});
    const ops: Document[] = [];
    let total = 0;

    for await (const person of cursor) {
      total += 1;
      const messagesSent = person.messagesSent ?? 0;
      const reactionsGiven = person.reactionsGiven ?? 0;
      const activeDates = ((person as { activeDates?: string[] }).activeDates ?? [])
        .slice()
        .sort();

      const streaks = streakOf(activeDates);
      const lastMessageAt = person.lastMessageAt ? new Date(person.lastMessageAt) : null;
      const firstSeenAt = person.firstSeenAt ? new Date(person.firstSeenAt) : null;
      const daysSinceLastMessage = lastMessageAt ? daysBetween(lastMessageAt, now) : null;
      const activeGroups = (person.groups ?? []).filter((g) => g.active);

      const last7 = person.messagesLast7d ?? 0;
      const prev7 = person.messagesPrev7d ?? 0;

      const set: Document = {
        groupCount: (person.groups ?? []).length,
        activeGroupCount: activeGroups.length,
        tenureDays: firstSeenAt ? Math.max(daysBetween(firstSeenAt, now), 0) : 0,
        daysSinceLastMessage,
        currentStreakDays: streaks.current,
        longestStreakDays: streaks.longest,
        reactionsReceivedPerMessage: ratio(person.reactionsReceived ?? 0, messagesSent),
        repliesReceivedPerMessage: ratio(person.repliesReceived ?? 0, messagesSent),
        messagesPerActiveDay: ratio(messagesSent, person.activeDays ?? 0),
        trend7d: trendOf(last7, prev7),
        topEmojis: (person.emojisUsed ?? []).slice(0, 10).map((emoji) => ({ emoji, count: 0 })),
        // Quem está no grupo e nunca falou: invisível em qualquer contagem
        // baseada em mensagem, mas continua alcançável para um convite.
        isLurker: messagesSent === 0 && activeGroups.length > 0,
        isDormant:
          messagesSent > 0 &&
          daysSinceLastMessage !== null &&
          daysSinceLastMessage > SCORING.dormantAfterDays,
        isAdminSomewhere: (person.groups ?? []).some((g) => g.isAdmin),
        isMultiGroup: activeGroups.length > 1,
        // Quem quase não escreve mas reage: engajamento real que o volume
        // de mensagens sozinho não enxerga.
        isObserver: messagesSent <= SCORING.observerMaxMessages && reactionsGiven > 0,
        updatedAt: now,
      };

      ops.push({
        updateOne: {
          filter: { _id: person._id },
          // `activeDates` é material de trabalho da agregação: numa pessoa
          // ativa há um ano são ~3 KB por documento que não servem para
          // consulta nenhuma. Some depois de virar sequência de dias.
          update: { $set: set, $unset: { activeDates: '' } },
        },
      });

      if (ops.length >= 500) {
        await people.bulkWrite(ops as never, { ordered: false });
        ops.length = 0;
      }
    }

    if (ops.length) await people.bulkWrite(ops as never, { ordered: false });
    return total;
  }

  // -------------------------------------------------------------------------
  // 6. derivados por grupo
  // -------------------------------------------------------------------------

  private async refreshGroups(db: Db): Promise<number> {
    const groups = db.collection<GroupDoc>(this.col(COLLECTIONS.groups));
    const messages = db.collection(this.col(COLLECTIONS.messages));
    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));

    const day7 = dateKeyDaysAgo(7);
    const day14 = dateKeyDaysAgo(14);
    const day30 = dateKeyDaysAgo(30);
    const dateExpr = { $dateToString: { format: '%Y-%m-%d', date: '$sentAt', timezone: TZ } };

    const perGroup = await messages
      .aggregate<{
        _id: string;
        totalMessages: number;
        mediaMessages: number;
        messagesWithReaction: number;
        messagesWithReply: number;
        totalReactionsOnMessages: number;
        messagesLast7d: number;
        messagesPrev7d: number;
        active7: string[];
        active30: string[];
        authorsEver: string[];
      }>([
        {
          $group: {
            _id: '$groupId',
            totalMessages: { $sum: 1 },
            mediaMessages: { $sum: { $cond: ['$isMedia', 1, 0] } },
            messagesWithReaction: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ['$reactionsCount', 0] }, 0] }, 1, 0] },
            },
            messagesWithReply: {
              $sum: { $cond: [{ $gt: [{ $ifNull: ['$repliesCount', 0] }, 0] }, 1, 0] },
            },
            totalReactionsOnMessages: { $sum: { $ifNull: ['$reactionsCount', 0] } },
            messagesLast7d: { $sum: { $cond: [{ $gte: [dateExpr, day7] }, 1, 0] } },
            messagesPrev7d: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: [dateExpr, day14] }, { $lt: [dateExpr, day7] }] }, 1, 0,
                ],
              },
            },
            active7: {
              $addToSet: { $cond: [{ $gte: [dateExpr, day7] }, '$authorId', '$$REMOVE'] },
            },
            active30: {
              $addToSet: { $cond: [{ $gte: [dateExpr, day30] }, '$authorId', '$$REMOVE'] },
            },
            authorsEver: { $addToSet: '$authorId' },
          },
        },
      ])
      .toArray();

    const byGroup = new Map(perGroup.map((row) => [row._id, row]));
    const now = new Date();
    let total = 0;

    for await (const group of groups.find({})) {
      total += 1;
      const agg = byGroup.get(group._id);
      const totalMessages = agg?.totalMessages ?? 0;

      const members = await people
        .find({ groups: { $elemMatch: { groupId: group._id, active: true } } })
        .project<{ _id: string; name: string | null; ddd: string | null; isInternational: boolean; groups: PersonDoc['groups'] }>(
          { name: 1, ddd: 1, isInternational: 1, groups: 1 },
        )
        .toArray();

      const participants = members.map((m) => ({
        personId: m._id,
        name: m.name ?? null,
        isAdmin: (m.groups ?? []).find((g) => g.groupId === group._id)?.isAdmin ?? false,
        active: true,
      }));

      const perAuthor = await this.messagesPerAuthor(db, group._id);
      const concentration = concentrationOf(perAuthor.map((a) => a.count));

      const dddDistribution: Record<string, number> = {};
      for (const member of members) {
        const key = member.isInternational ? 'internacional' : (member.ddd ?? 'desconhecido');
        dddDistribution[key] = (dddDistribution[key] ?? 0) + 1;
      }

      const memberCount = members.length;
      const activeMembers30d = agg?.active30.length ?? 0;
      const authorsEver = agg?.authorsEver.length ?? 0;
      const lastMessageAt = group.lastMessageAt ? new Date(group.lastMessageAt) : null;

      const names = new Map(members.map((m) => [m._id, m.name ?? null]));

      const set: Document = {
        participants,
        memberCount,
        admins: participants.filter((p) => p.isAdmin).map((p) => p.personId),
        totalMessages,
        mediaMessages: agg?.mediaMessages ?? 0,
        messagesWithReaction: agg?.messagesWithReaction ?? 0,
        messagesWithReply: agg?.messagesWithReply ?? 0,
        activeMembers7d: agg?.active7.length ?? 0,
        activeMembers30d,
        // "800 pessoas" contra "800 pessoas conversando": é a diferença entre
        // um grupo grande e um grupo vivo.
        participationRate: ratio(activeMembers30d, memberCount),
        silentMemberCount: Math.max(memberCount - authorsEver, 0),
        reactionRate: ratio(agg?.messagesWithReaction ?? 0, totalMessages),
        avgReactionsPerMessage: ratio(agg?.totalReactionsOnMessages ?? 0, totalMessages),
        replyRate: ratio(agg?.messagesWithReply ?? 0, totalMessages),
        mediaShare: ratio(agg?.mediaMessages ?? 0, totalMessages),
        top10SharePct: concentration.top10SharePct,
        giniMessages: concentration.gini,
        topPosters: perAuthor.slice(0, 10).map((a) => ({
          personId: a.personId, name: names.get(a.personId) ?? null, count: a.count,
        })),
        topReactors: await this.topReactors(db, group._id, names),
        topReceivers: await this.topReceivers(db, group._id, names),
        peakHours: peakHoursOf(group.hourHistogram ?? {}),
        dddDistribution,
        messagesLast7d: agg?.messagesLast7d ?? 0,
        messagesPrev7d: agg?.messagesPrev7d ?? 0,
        trend7d: trendOf(agg?.messagesLast7d ?? 0, agg?.messagesPrev7d ?? 0),
        daysSinceLastMessage: lastMessageAt ? daysBetween(lastMessageAt, now) : null,
        updatedAt: now,
      };

      await groups.updateOne({ _id: group._id }, { $set: set });
    }

    return total;
  }

  private async messagesPerAuthor(
    db: Db,
    groupId: string,
  ): Promise<Array<{ personId: string; count: number }>> {
    const rows = await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate<{ _id: string; count: number }>([
        { $match: { groupId, authorId: { $ne: null } } },
        { $group: { _id: '$authorId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();
    return rows.map((r) => ({ personId: r._id, count: r.count }));
  }

  private async topReactors(
    db: Db,
    groupId: string,
    names: Map<string, string | null>,
  ): Promise<Array<{ personId: string; name: string | null; count: number }>> {
    const rows = await db
      .collection(this.col(COLLECTIONS.reactions))
      .aggregate<{ _id: string; count: number }>([
        { $match: { groupId, active: true } },
        { $group: { _id: '$personId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();
    return rows.map((r) => ({ personId: r._id, name: names.get(r._id) ?? null, count: r.count }));
  }

  /** Quem mais recebe reação — ressonância, que é diferente de volume. */
  private async topReceivers(
    db: Db,
    groupId: string,
    names: Map<string, string | null>,
  ): Promise<Array<{ personId: string; name: string | null; count: number }>> {
    const rows = await db
      .collection(this.col(COLLECTIONS.messages))
      .aggregate<{ _id: string; count: number }>([
        { $match: { groupId, authorId: { $ne: null } } },
        { $group: { _id: '$authorId', count: { $sum: { $ifNull: ['$reactionsCount', 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();
    return rows
      .filter((r) => r.count > 0)
      .map((r) => ({ personId: r._id, name: names.get(r._id) ?? null, count: r.count }));
  }

  // -------------------------------------------------------------------------
  // 7. score e tier
  // -------------------------------------------------------------------------

  /**
   * O score é um percentil, não um valor absoluto: comparar "40 mensagens" num
   * grupo de 20 pessoas com "40 mensagens" num de 800 não diria nada. Assim,
   * 90 significa sempre "está entre os 10% mais engajados".
   *
   * O percentil é calculado **só entre quem participa** — quem já mandou ao
   * menos uma mensagem ou deu ao menos uma reação. Num grupo de 830 pessoas em
   * que 825 nunca falaram, incluir todo mundo faria o score responder apenas
   * "você não é um silencioso": qualquer pessoa com uma única mensagem saltaria
   * para o percentil 99 e as ativas ficariam indistinguíveis entre si. Quem não
   * participa recebe 0 e é separado pelo `tier`, que é onde essa informação
   * realmente pertence.
   */
  private async scoreAndTier(db: Db): Promise<void> {
    const people = db.collection<PersonDoc>(this.col(COLLECTIONS.people));

    const participa = {
      $or: [{ messagesSent: { $gt: 0 } }, { reactionsGiven: { $gt: 0 } }],
    };

    // Silenciosos: score zero, mas o tier continua distinguindo lurker de
    // dormant — é o tier que responde "dá para convidar?".
    await people.updateMany({ $nor: [participa] }, [
      {
        $set: {
          engagementScore: 0,
          tier: {
            $cond: [{ $eq: ['$isDormant', true] }, 'dormant', 'lurker'],
          },
        },
      },
    ]);

    const all = await people
      .find(participa)
      .project<{
        _id: string;
        messagesSent?: number;
        activeDaysLast30?: number;
        reactionsReceived?: number;
        repliesReceived?: number;
        daysSinceLastMessage?: number | null;
        isLurker?: boolean;
        isDormant?: boolean;
        isObserver?: boolean;
      }>({
        messagesSent: 1, activeDaysLast30: 1, reactionsReceived: 1,
        repliesReceived: 1, daysSinceLastMessage: 1,
        isLurker: 1, isDormant: 1, isObserver: 1,
      })
      .toArray();
    if (all.length === 0) return;

    const volume = percentiles(all.map((p) => p.messagesSent ?? 0));
    const consistency = percentiles(all.map((p) => p.activeDaysLast30 ?? 0));
    const resonance = percentiles(
      all.map((p) =>
        ratio((p.reactionsReceived ?? 0) + (p.repliesReceived ?? 0), p.messagesSent ?? 0),
      ),
    );
    // Recência invertida: quem falou ontem vale mais que quem falou há um mês.
    const recency = percentiles(
      all.map((p) => -(p.daysSinceLastMessage ?? SCORING.dormantAfterDays * 2)),
    );

    const ops = all.map((person, index) => {
      const score =
        SCORING.weights.volume * (volume[index] ?? 0) +
        SCORING.weights.consistency * (consistency[index] ?? 0) +
        SCORING.weights.resonance * (resonance[index] ?? 0) +
        SCORING.weights.recency * (recency[index] ?? 0);

      const rounded = Math.round(score * 10) / 10;
      return {
        updateOne: {
          filter: { _id: person._id },
          update: {
            $set: {
              engagementScore: rounded,
              tier: tierOf(rounded, {
                messagesSent: person.messagesSent ?? 0,
                isLurker: person.isLurker ?? false,
                isDormant: person.isDormant ?? false,
                isObserver: person.isObserver ?? false,
              }),
            },
          },
        },
      };
    });

    await people.bulkWrite(ops as never, { ordered: false });
  }
}

// ---------------------------------------------------------------------------
// auxiliares puros
// ---------------------------------------------------------------------------

export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function trendOf(last: number, previous: number): 'rising' | 'stable' | 'falling' {
  if (last === 0 && previous === 0) return 'stable';
  if (previous === 0) return last > 0 ? 'rising' : 'stable';
  const change = (last - previous) / previous;
  if (change >= SCORING.trendThreshold) return 'rising';
  if (change <= -SCORING.trendThreshold) return 'falling';
  return 'stable';
}

/** Sequência de dias consecutivos com atividade: a atual e a mais longa. */
export function streakOf(sortedDates: string[]): { current: number; longest: number } {
  if (sortedDates.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < sortedDates.length; i += 1) {
    const previous = sortedDates[i - 1];
    const current = sortedDates[i];
    if (!previous || !current) continue;
    const gap = daysBetween(new Date(`${previous}T00:00:00Z`), new Date(`${current}T00:00:00Z`));
    if (gap === 1) run += 1;
    else if (gap > 1) run = 1;
    if (run > longest) longest = run;
  }

  // A sequência atual só conta se chega até hoje ou ontem — uma sequência que
  // terminou há duas semanas não diz nada sobre engajamento agora.
  const last = sortedDates[sortedDates.length - 1];
  const today = new Date();
  const gapToToday = last
    ? daysBetween(new Date(`${last}T00:00:00Z`), new Date(today.toISOString().slice(0, 10) + 'T00:00:00Z'))
    : Infinity;

  return { current: gapToToday <= 1 ? run : 0, longest };
}

/**
 * Concentração da conversa. `top10SharePct` responde direto: o grupo é uma
 * conversa ou é um punhado de pessoas falando sozinhas?
 */
export function concentrationOf(counts: number[]): { top10SharePct: number; gini: number } {
  const values = counts.filter((c) => c > 0).sort((a, b) => b - a);
  const total = values.reduce((sum, c) => sum + c, 0);
  if (total === 0 || values.length === 0) return { top10SharePct: 0, gini: 0 };

  const topCount = Math.max(1, Math.ceil(values.length * 0.1));
  const topSum = values.slice(0, topCount).reduce((sum, c) => sum + c, 0);

  // Gini pela fórmula da diferença média relativa, sobre a série ordenada.
  const ascending = [...values].reverse();
  let weighted = 0;
  ascending.forEach((value, index) => {
    weighted += (index + 1) * value;
  });
  const n = ascending.length;
  const gini = n > 1 ? (2 * weighted) / (n * total) - (n + 1) / n : 0;

  return {
    top10SharePct: Math.round((topSum / total) * 1000) / 10,
    gini: Math.round(Math.max(gini, 0) * 1000) / 1000,
  };
}

/** As horas com mais mensagens — quando vale a pena mandar um convite. */
export function peakHoursOf(histogram: Record<string, number>): number[] {
  return Object.entries(histogram)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .filter(([, count]) => count > 0)
    .map(([hour]) => Number(hour))
    .sort((a, b) => a - b);
}

/**
 * Percentil de cada valor dentro da própria série, de 0 a 100.
 * Empates recebem o mesmo percentil — senão duas pessoas com o mesmo número de
 * mensagens teriam scores diferentes por acidente de ordenação.
 */
export function percentiles(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  const sorted = [...values].sort((a, b) => a - b);
  const rankOf = new Map<number, number>();
  sorted.forEach((value, index) => {
    if (!rankOf.has(value)) rankOf.set(value, index);
  });

  return values.map((value) => {
    const rank = rankOf.get(value) ?? 0;
    return Math.round((rank / (n - 1)) * 1000) / 10;
  });
}
