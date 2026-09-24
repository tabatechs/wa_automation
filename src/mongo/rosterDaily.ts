/**
 * A lista oficial do dia — ver `GroupRosterDailyDoc` em `schema.ts` para o
 * porquê. Aqui ficam as regras, sem I/O, compartilhadas entre o caminho quente
 * (`Ingestor`) e a reconstrução a partir do JSONL (`mongo:roster-backfill`).
 */

import type { CapturedEvent } from '../types';
import { timeParts } from '../util/time';
import { aliasesOf, isPendingId, resolvePersonId } from './identity';
import type { GroupRosterDailyDoc } from './schema';

/** Traduz o `personId` calculado no evento para o `_id` que vale hoje. */
export type PersonIdResolver = (participant: Parameters<typeof aliasesOf>[0]) => string | null;

/** No caminho quente o id é o do próprio evento; a fusão repontará depois. */
export const eventPersonId: PersonIdResolver = (participant) => resolvePersonId(participant);

/**
 * A linha candidata que um snapshot produziria. Null quando ele não serve de
 * lista oficial: não é de boot, não tem grupo, ou veio vazio — vazio no boot
 * é sincronização pela metade, não grupo que esvaziou.
 */
export function rosterFromSnapshot(
  event: CapturedEvent,
  resolve: PersonIdResolver = eventPersonId,
): GroupRosterDailyDoc | null {
  if (event.type !== 'group_snapshot') return null;
  const groupId = event.group?.id;
  if (!groupId || event.payload.reason !== 'boot') return null;
  if (event.payload.participants.length === 0) return null;

  const members = new Set<string>();
  const admins = new Set<string>();
  for (const participant of event.payload.participants) {
    const personId = resolve(participant);
    if (!personId) continue;
    members.add(personId);
    if (participant.isAdmin) admins.add(personId);
  }
  if (members.size === 0) return null;

  const capturedAt = new Date(event.capturedAt);
  const date = timeParts(capturedAt).date;
  return {
    _id: `${groupId}|${date}`,
    groupId,
    date,
    capturedAt,
    source: 'boot',
    members: [...members],
    admins: [...admins],
  };
}

/** A mais antiga das duas; em empate fica a primeira. */
export function earliest(
  a: GroupRosterDailyDoc,
  b: GroupRosterDailyDoc,
): GroupRosterDailyDoc {
  return b.capturedAt.getTime() < a.capturedAt.getTime() ? b : a;
}

export type RosterWrite =
  /** O dia ainda não tem lista. */
  | 'insert'
  /** A candidata é de um boot anterior ao que está gravado: ela é a oficial. */
  | 'replace'
  /** Mesmo snapshot, ids diferentes — alguém foi fundido depois. */
  | 'repoint'
  /** Nada a fazer. */
  | 'keep';

/**
 * O que fazer com uma candidata diante do que já está no banco.
 *
 * "O boot mais antigo ganha" é uma ordem total, e é isso que deixa o caminho
 * quente e a reconstrução convergirem: o monitor grava o primeiro boot que
 * viu, e se o JSONL tiver um anterior (o Mongo estava fora, ou a coleção
 * nasceu no meio do dia) a reconstrução o põe no lugar. Rodar de novo não
 * muda nada.
 */
export function decideRosterWrite(
  existing: Pick<GroupRosterDailyDoc, 'capturedAt' | 'members' | 'admins'> | null,
  candidate: GroupRosterDailyDoc,
): RosterWrite {
  if (!existing) return 'insert';
  const antes = existing.capturedAt.getTime();
  const agora = candidate.capturedAt.getTime();
  if (agora < antes) return 'replace';
  if (agora > antes) return 'keep';
  return sameSet(existing.members, candidate.members) && sameSet(existing.admins, candidate.admins)
    ? 'keep'
    : 'repoint';
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** O mínimo de `people` que a resolução precisa. */
export interface PersonKeys {
  _id: string;
  aliases?: string[];
  mergedFrom?: string[];
}

/**
 * Resolve ids para o `_id` atual de `people`.
 *
 * Um snapshot de semanas atrás carimbou o id que valia naquele dia. Se a
 * pessoa foi fundida depois (um `lid:` que ganhou telefone), o id velho já não
 * existe — e comparar a lista de ontem, com o id velho, com a de hoje, com o
 * novo, daria uma saída e uma entrada falsas. A ordem: o id ainda existe →
 * ele; foi drenado numa fusão → o destino; algum alias do participante
 * pertence a alguém → esse alguém, preferindo quem já tem telefone.
 */
export function canonicalResolver(people: Iterable<PersonKeys>): PersonIdResolver {
  const ids = new Set<string>();
  const merged = new Map<string, string>();
  const byAlias = new Map<string, string>();

  for (const person of people) {
    ids.add(person._id);
    for (const old of person.mergedFrom ?? []) merged.set(old, person._id);
    for (const alias of person.aliases ?? []) {
      const current = byAlias.get(alias);
      if (!current || (isPendingId(current) && !isPendingId(person._id))) {
        byAlias.set(alias, person._id);
      }
    }
  }

  return (participant) => {
    const personId = resolvePersonId(participant);
    if (!personId) return null;
    if (ids.has(personId)) return personId;
    const destino = merged.get(personId);
    if (destino) return destino;
    for (const alias of aliasesOf(participant)) {
      const dono = byAlias.get(alias);
      if (dono) return dono;
    }
    return personId;
  };
}
