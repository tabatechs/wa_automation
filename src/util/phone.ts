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
