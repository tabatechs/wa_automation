/**
 * Conversões em torno do chat id do WhatsApp.
 *
 * Formatos relevantes:
 *   - contato : "5511999998888@c.us"
 *   - grupo   : "120363000000000000@g.us"  (id atribuído pelo WhatsApp, opaco)
 *   - lid     : "123456789@lid"            (identificador anônimo do multi-device)
 *
 * O id é sempre a chave canônica; o número é derivado e pode não existir.
 */

const CONTACT_SUFFIX = '@c.us';
const GROUP_SUFFIX = '@g.us';

export function isGroupId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.endsWith(GROUP_SUFFIX);
}

export function isContactId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.endsWith(CONTACT_SUFFIX);
}

/**
 * Extrai o número em E.164 de um chat id de contato.
 *
 * Devolve null para ids de grupo, ids "@lid" (que não carregam número) e
 * qualquer coisa que não seja só dígitos — nunca inventa um número.
 */
export function chatIdToE164(id: string | null | undefined): string | null {
  if (!id || !isContactId(id)) return null;
  const digits = id.slice(0, -CONTACT_SUFFIX.length);
  if (!/^\d{7,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Só os dígitos de um E.164 — a chave usada para identificar uma pessoa. */
export function e164ToDigits(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

export interface ParsedPhone {
  /** Número fora do Brasil. Nesse caso `ddd` e `isMobile` são sempre null. */
  isInternational: boolean;
  /** DDD de 2 dígitos, só para números brasileiros. */
  ddd: string | null;
  /** Celular brasileiro: assinante com 9 dígitos começando em 9. */
  isMobile: boolean | null;
}

const BR_COUNTRY_CODE = '55';
/** DDDs válidos vão de 11 a 99; nenhum começa com 0 ou 1 seguido de 0. */
const BR_NATIONAL = /^([1-9][1-9])(\d{8,9})$/;

/**
 * Extrai DDD de um número brasileiro.
 *
 * Códigos de país têm 1, 2 ou 3 dígitos e não há como separá-los com segurança
 * sem uma tabela de prefixos — então nem se tenta: ou o número começa com 55 e
 * o DDD é conhecido, ou ele é apenas marcado como internacional.
 */
export function parsePhone(e164: string | null | undefined): ParsedPhone {
  const digits = e164ToDigits(e164);
  if (!digits) return { isInternational: false, ddd: null, isMobile: null };

  if (!digits.startsWith(BR_COUNTRY_CODE)) {
    return { isInternational: true, ddd: null, isMobile: null };
  }

  const national = digits.slice(BR_COUNTRY_CODE.length);
  const match = BR_NATIONAL.exec(national);
  // Começa com 55 mas não tem forma de número brasileiro (ex.: +55 5 12345678,
  // ou um país cujo código também começa com 55). Não inventa um DDD.
  if (!match) return { isInternational: false, ddd: null, isMobile: null };

  const [, ddd, subscriber] = match as unknown as [string, string, string];
  return {
    isInternational: false,
    ddd,
    isMobile: subscriber.length === 9 && subscriber.startsWith('9'),
  };
}

/** Converte um timestamp do WhatsApp (segundos ou milissegundos) para ISO 8601. */
export function waTimestampToIso(timestamp: number | null | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  // O WhatsApp usa segundos na maioria dos campos, mas alguns vêm em ms.
  const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
