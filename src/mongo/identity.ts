/**
 * Decide qual é o `_id` de uma pessoa.
 *
 * O WhatsApp entrega a mesma pessoa por dois caminhos: mensagens e reações
 * trazem o autor como `@lid`, enquanto a lista de participantes traz `@c.us`.
 * Sem unificar os dois, cada apoiador vira dois documentos e todas as métricas
 * saem pela metade.
 *
 * A chave é o **telefone**, quando conhecido. O `Roster` já faz a ponte
 * LID→`@c.us` e preenche `actor.phone` na maior parte dos casos; quando não
 * consegue, a pessoa recebe um `_id` provisório `lid:<id>` e o recálculo
 * agendado funde esse documento no do telefone assim que o vínculo aparecer
 * (ver `mergePendingIdentities` em `metrics.ts`).
 *
 * Tudo aqui é função pura, sem I/O: roda no caminho quente, uma vez por evento.
 */

import type { Actor } from '../types';
import { isLid, normalizeLid } from '../enrich/lid';
import { e164ToDigits, parsePhone } from '../util/phone';

/** Prefixo dos `_id` provisórios, os que ainda esperam por um telefone. */
export const PENDING_PREFIX = 'lid:';

export function isPendingId(personId: string): boolean {
  return personId.startsWith(PENDING_PREFIX);
}

export interface PersonIdentity {
  personId: string;
  phone: string | null;
  ddd: string | null;
  isInternational: boolean;
  isMobile: boolean | null;
  name: string | null;
  nameSource: string | null;
  /** Ids do WhatsApp conhecidos para esta pessoa, para reencontrá-la depois. */
  aliases: string[];
}

/**
 * Id canônico a partir de um ator. Devolve null só quando não há id nenhum.
 *
 * Ordem: telefone → LID normalizado → id bruto. As duas últimas são provisórias
 * e existem para que um evento nunca seja descartado por falta de identidade.
 */
export function resolvePersonId(actor: Actor | null | undefined): string | null {
  if (!actor?.id) return null;

  const digits = e164ToDigits(actor.phone);
  if (digits) return digits;

  const id = actor.id;
  if (isLid(id)) {
    // `199372465811459:71@lid` e `199372465811459@lid` são a mesma pessoa.
    const normalized = normalizeLid(id);
    return `${PENDING_PREFIX}${normalized.slice(0, -'@lid'.length)}`;
  }

  // `@c.us` sem número derivável é raro, mas não pode custar o evento.
  return `${PENDING_PREFIX}${id}`;
}

/**
 * Chave estável de um ator, para compor `_id` de documentos.
 *
 * Diferente do `personId`, esta chave **não muda** quando o telefone da pessoa
 * finalmente é descoberto. Isso importa: se o `_id` de uma reação dependesse do
 * `personId`, a mesma reação ganharia um segundo documento assim que a pessoa
 * saísse de `lid:` para telefone, e ela seria contada duas vezes.
 */
export function stableActorKey(actor: Actor | null | undefined): string | null {
  if (!actor?.id) return null;
  return isLid(actor.id) ? normalizeLid(actor.id) : actor.id;
}

/** Todos os campos de identidade de uma pessoa, prontos para o upsert. */
export function resolveIdentity(actor: Actor | null | undefined): PersonIdentity | null {
  const personId = resolvePersonId(actor);
  if (!personId || !actor) return null;

  const digits = e164ToDigits(actor.phone);
  const phone = digits ? `+${digits}` : null;
  const parsed = parsePhone(phone);

  return {
    personId,
    phone,
    ddd: parsed.ddd,
    isInternational: parsed.isInternational,
    isMobile: parsed.isMobile,
    name: actor.name,
    nameSource: actor.nameSource,
    aliases: aliasesOf(actor),
  };
}

/**
 * Ids sob os quais esta pessoa pode reaparecer. É a trilha que permite ao
 * recálculo reconhecer que um `lid:` provisório e um telefone são a mesma
 * pessoa — sem isso, a fusão não teria por onde começar.
 */
export function aliasesOf(actor: Actor): string[] {
  const aliases = new Set<string>();
  const id = actor.id;
  if (id) {
    aliases.add(isLid(id) ? normalizeLid(id) : id);
    // O sufixo de dispositivo também vale como alias: eventos antigos, gravados
    // antes da normalização, ainda carregam essa forma no JSONL.
    if (isLid(id) && id !== normalizeLid(id)) aliases.add(id);
  }
  const digits = e164ToDigits(actor.phone);
  if (digits) aliases.add(`${digits}@c.us`);
  return [...aliases];
}
