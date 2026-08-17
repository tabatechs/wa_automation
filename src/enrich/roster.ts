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
import { LidResolver, isLid, normalizeLid } from './lid';

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
  /**
   * Última lista que veio inteira, por grupo. Sem TTL e nunca sobrescrita por
   * lista vazia: é a rede de segurança para quando o WA Web devolve lixo, e o
   * que impede "o grupo inteiro saiu" de virar evento.
   */
  private readonly lastGoodMembers = new Map<string, ParticipantSnapshot[]>();

  private readonly lids: LidResolver;
  /** Chat id `@c.us` da conta conectada, para atribuir autoria das próprias mensagens. */
  private hostId: string | null = null;

  constructor(
    private client: Client,
    private readonly ttlMs: number,
  ) {
    this.lids = new LidResolver(client);
  }

  /** Substitui o client após um restart de sessão, preservando o cache. */
  setClient(client: Client): void {
    this.client = client;
    this.lids.setClient(client);
  }

  /**
   * Descobre o número da conta conectada. Mensagens com `fromMe` chegam sem
   * autor identificável, então sem isto elas sairiam com actor nulo.
   */
  async loadHostIdentity(): Promise<void> {
    try {
      const raw = await this.client.getHostNumber();
      const digits = String(raw ?? '').replace(/\D/g, '');
      if (digits) {
        this.hostId = `${digits}@c.us`;
        log.info('conta conectada identificada', { hostId: this.hostId });
      }
    } catch (error) {
      log.warn('getHostNumber falhou; mensagens próprias ficarão sem autor', error);
    }
  }

  /** Autor a usar quando a mensagem é da própria conta. */
  async resolveSelf(): Promise<Actor | null> {
    return this.hostId ? this.resolve(this.hostId) : null;
  }

  /**
   * Resolve um contato. Nunca lança: se a consulta falhar, devolve o Actor só com
   * id e número — perder o nome é aceitável, perder o evento não.
   */
  async resolve(contactId: string | null | undefined): Promise<Actor | null> {
    if (!contactId) return null;

    // O mesmo LID chega ora com sufixo de dispositivo (`...:71@lid`), ora sem.
    // Normalizar aqui é o que garante que os dois virem UM ator só — sem isso a
    // mesma pessoa se divide em dois ids e as métricas saem pela metade.
    const canonicalId = isLid(contactId) ? normalizeLid(contactId) : contactId;

    const cached = this.contacts.get(canonicalId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Autor de mensagem/reação em grupo chega como LID, que não carrega número.
    // Traduz para @c.us quando possível, mas mantém o LID como id do evento:
    // ele é a chave estável, e trocá-la quebraria a deduplicação a posteriori.
    let phone = chatIdToE164(canonicalId);
    let lookupId = canonicalId;
    if (!phone && isLid(canonicalId)) {
      const mapped = await this.lids.toContactId(canonicalId);
      if (mapped) {
        phone = chatIdToE164(mapped);
        lookupId = mapped;
      }
    }

    let actor: Actor = {
      id: canonicalId,
      phone,
      name: null,
      nameSource: null,
    };

    try {
      const contact = await this.client.getContact(lookupId as Parameters<Client['getContact']>[0]);
      const { name, nameSource } = pickName(contact);
      actor = { ...actor, name, nameSource };
      // O objeto devolvido pode trazer o vínculo que ainda não conhecíamos.
      this.lids.learnFromContacts([contact]);
    } catch (error) {
      log.debug('getContact falhou, seguindo só com o id', { contactId, error: String(error) });
    }

    this.contacts.set(canonicalId, { value: actor, expiresAt: Date.now() + this.ttlMs });
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
   *
   * `waitForMembers` cobre o boot: logo depois de a sessão ficar pronta, os
   * metadados de um grupo grande ainda podem não ter sincronizado, e a chamada
   * devolve lista vazia — foi o que produziu um group_snapshot com 0
   * participantes num grupo de 830. Nesse caso vale a pena insistir.
   */
  async groupMembers(groupId: string, waitForMembers = false): Promise<ParticipantSnapshot[]> {
    const cached = this.members.get(groupId);
    if (cached && cached.expiresAt > Date.now() && cached.value.length > 0) return cached.value;

    let snapshot = await this.fetchMembers(groupId);

    if (snapshot.length === 0 && waitForMembers) {
      const delaysMs = [500, 1000, 2000, 4000, 8000];
      for (const delay of delaysMs) {
        await sleep(delay);
        snapshot = await this.fetchMembers(groupId);
        if (snapshot.length > 0) {
          log.info('participantes carregaram após espera', { groupId, total: snapshot.length });
          break;
        }
      }
      if (snapshot.length === 0) {
        log.warn('grupo continua sem participantes após as tentativas', { groupId });
      }
    }

    // Nada utilizável agora: vale mais a última lista boa, mesmo velha, do que
    // uma vazia. Quem consome isto compara com a execução anterior, e o vazio
    // no lugar de 800 pessoas vira "o grupo inteiro saiu". O cache com TTL
    // continua sem a lista, então a próxima chamada tenta de novo.
    if (snapshot.length === 0) {
      const ultimaBoa = this.lastGoodMembers.get(groupId);
      if (ultimaBoa?.length) {
        log.warn('lista de participantes indisponível; usando a última conhecida', {
          groupId,
          total: ultimaBoa.length,
        });
        return ultimaBoa;
      }
      return snapshot;
    }

    this.members.set(groupId, { value: snapshot, expiresAt: Date.now() + this.ttlMs });
    this.lastGoodMembers.set(groupId, snapshot);
    return snapshot;
  }

  private async fetchMembers(groupId: string): Promise<ParticipantSnapshot[]> {
    let snapshot: ParticipantSnapshot[] = [];
    try {
      const contacts = await this.client.getGroupMembers(
        groupId as Parameters<Client['getGroupMembers']>[0],
      );

      // Quando o `getGroupParticipantIDs` do WA Web falha ("group members ids
      // is not an array / this.$1 is not a function"), o open-wa não propaga
      // erro: devolve a lista com o tamanho certo e os contatos vazios, sem id.
      // Uma lista assim é pior que nenhuma — os que perderam o id somem da
      // comparação com a execução anterior e viram saída em massa (foi o que
      // produziu 723 "saíram do grupo" falsos num grupo de 813). Descarta-se
      // tudo: quem chamou refaz a busca ou fica com a última lista boa.
      const semId = (contacts ?? []).filter((contact) => !String(contact?.id ?? '')).length;
      if (semId > 0) {
        log.warn('getGroupMembers devolveu participantes sem id; lista descartada', {
          groupId,
          total: contacts?.length ?? 0,
          semId,
        });
        return [];
      }

      // Os membros vêm como @c.us e podem carregar o LID correspondente:
      // é a fonte mais barata de vínculos para os eventos de mensagem.
      this.lids.learnFromContacts(contacts ?? []);
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

    // Quem cacheia é groupMembers(); aqui só buscamos.
    return snapshot;
  }

  /** Invalida o cache de um grupo — chamado quando os participantes mudam. */
  invalidateGroup(groupId: string): void {
    this.members.delete(groupId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
