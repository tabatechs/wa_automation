/**
 * Resolve nome e número dos participantes.
 *
 * O WhatsApp expõe vários campos de nome e nenhum é garantido — a doc do open-wa
 * avisa que "display data is contextual; always use `id` for lookups". Por isso o
 * evento sempre carrega o `id` canônico e registra de qual campo o nome veio.
 *
 * Sem cache, cada mensagem custaria uma chamada getContact ao browser. O cache
 * por TTL derruba isso para ~1 chamada por participante a cada 15 min.
 */

import type { Client, Contact } from '@open-wa/wa-automate';
import type { Actor, NameSource, ParticipantSnapshot } from '../types';
import { chatIdToE164 } from '../util/phone';
import { createLogger } from '../util/logger';

const log = createLogger('roster');

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Precedência dos campos de nome, do mais confiável ao mais volátil. */
function pickName(contact: Partial<Contact> | null | undefined): {
  name: string | null;
  nameSource: NameSource;
} {
  if (!contact) return { name: null, nameSource: null };

  const candidates: Array<[NameSource, unknown]> = [
    ['contact', contact.name],
    ['formattedName', contact.formattedName],
    ['pushname', contact.pushname],
    ['shortName', contact.shortName],
  ];

  for (const [source, raw] of candidates) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      // O WhatsApp devolve o próprio número como "nome" quando não há contato salvo;
      // isso não é um nome, e já temos o número em outro campo.
      if (trimmed && !isJustANumber(trimmed)) {
        return { name: trimmed, nameSource: source };
      }
    }
  }
  return { name: null, nameSource: null };
}

function isJustANumber(value: string): boolean {
  return /^[+\d\s()-]+$/.test(value);
}

export class Roster {
  private readonly contacts = new Map<string, CacheEntry<Actor>>();
  private readonly members = new Map<string, CacheEntry<ParticipantSnapshot[]>>();

  constructor(
    private client: Client,
    private readonly ttlMs: number,
  ) {}

  /** Substitui o client após um restart de sessão, preservando o cache. */
  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Resolve um contato. Nunca lança: se a consulta falhar, devolve o Actor só com
   * id e número — perder o nome é aceitável, perder o evento não.
   */
  async resolve(contactId: string | null | undefined): Promise<Actor | null> {
    if (!contactId) return null;

    const cached = this.contacts.get(contactId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let actor: Actor = {
      id: contactId,
      phone: chatIdToE164(contactId),
      name: null,
      nameSource: null,
    };

    try {
      const contact = await this.client.getContact(contactId as Parameters<Client['getContact']>[0]);
      const { name, nameSource } = pickName(contact);
      actor = { ...actor, name, nameSource };
    } catch (error) {
      log.debug('getContact falhou, seguindo só com o id', { contactId, error: String(error) });
    }

    this.contacts.set(contactId, { value: actor, expiresAt: Date.now() + this.ttlMs });
    return actor;
  }

  /** Resolve vários contatos em paralelo. */
  async resolveMany(ids: Array<string | null | undefined>): Promise<Actor[]> {
    const resolved = await Promise.all(ids.map((id) => this.resolve(id)));
    return resolved.filter((a): a is Actor => a !== null);
  }

  /**
   * Lista os participantes de um grupo com nome, número e flags de admin.
   * `getGroupMembers` é livre de licença na v4.
   */
  async groupMembers(groupId: string): Promise<ParticipantSnapshot[]> {
    const cached = this.members.get(groupId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let snapshot: ParticipantSnapshot[] = [];
    try {
      const contacts = await this.client.getGroupMembers(
        groupId as Parameters<Client['getGroupMembers']>[0],
      );
      snapshot = (contacts ?? []).map((contact) => {
        const id = String(contact?.id ?? '');
        const { name, nameSource } = pickName(contact);
        return {
          id,
          phone: chatIdToE164(id),
          name,
          nameSource,
          isAdmin: Boolean((contact as { isAdmin?: boolean })?.isAdmin),
          isSuperAdmin: Boolean((contact as { isSuperAdmin?: boolean })?.isSuperAdmin),
        };
      });

      // Aproveita para popular o cache de contatos e evitar chamadas futuras.
      for (const participant of snapshot) {
        this.contacts.set(participant.id, {
          value: {
            id: participant.id,
            phone: participant.phone,
            name: participant.name,
            nameSource: participant.nameSource,
          },
          expiresAt: Date.now() + this.ttlMs,
        });
      }
    } catch (error) {
      log.warn('getGroupMembers falhou', { groupId, error: String(error) });
    }

    this.members.set(groupId, { value: snapshot, expiresAt: Date.now() + this.ttlMs });
    return snapshot;
  }

  /** Invalida o cache de um grupo — chamado quando os participantes mudam. */
  invalidateGroup(groupId: string): void {
    this.members.delete(groupId);
  }
}
