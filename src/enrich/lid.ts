/**
 * Traduz LID para número de telefone.
 *
 * O WhatsApp multi-device identifica o autor de mensagens e reações em grupo
 * por um LID ("linked identity") — algo como `237194031669378@lid` — em vez do
 * `@c.us` que carrega o número. Já `getGroupMembers` devolve os participantes
 * como `@c.us`. Sem uma ponte entre os dois, todo evento de mensagem sai com
 * `phone: null`, mesmo com o nome resolvido.
 *
 * A tipagem do @open-wa/wa-automate 4.76.0 nem menciona LID (é anterior ao
 * rollout), então a ponte é construída aqui, em duas camadas:
 *
 *   1. Pelos objetos Contact do próprio roster — em runtime eles costumam
 *      trazer campos que a tipagem não declara (`lid`, `lidId`, ...).
 *   2. Consultando o store do WhatsApp Web pela página do puppeteer, quando a
 *      camada 1 não resolve.
 *
 * Nada aqui pode lançar: perder o número é aceitável, perder o evento não.
 */

import type { Client } from '@open-wa/wa-automate';
import { createLogger } from '../util/logger';

const log = createLogger('lid');

const LID_SUFFIX = '@lid';

export function isLid(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.endsWith(LID_SUFFIX);
}

/**
 * Um LID pode vir com sufixo de dispositivo (`199372465811459:71@lid`).
 * A identidade é a parte antes dos dois-pontos.
 */
export function normalizeLid(id: string): string {
  if (!isLid(id)) return id;
  const body = id.slice(0, -LID_SUFFIX.length);
  const colon = body.indexOf(':');
  return `${colon === -1 ? body : body.slice(0, colon)}${LID_SUFFIX}`;
}

/** Campos onde um LID costuma aparecer num objeto Contact em runtime. */
const LID_FIELDS = ['lid', 'lidId', 'linkedId', 'lidJid'] as const;

function extractLid(contact: unknown): string | null {
  if (!contact || typeof contact !== 'object') return null;
  const record = contact as Record<string, unknown>;
  for (const field of LID_FIELDS) {
    const raw = record[field];
    const value =
      typeof raw === 'string'
        ? raw
        : typeof (raw as { _serialized?: string })?._serialized === 'string'
          ? (raw as { _serialized: string })._serialized
          : null;
    if (value && isLid(value)) return normalizeLid(value);
  }
  return null;
}

export class LidResolver {
  /** LID normalizado -> chat id `@c.us`. */
  private readonly map = new Map<string, string>();
  /** LIDs que já tentamos resolver pela página e falharam. */
  private readonly misses = new Set<string>();
  private storeUnavailable = false;

  constructor(private client: Client) {}

  setClient(client: Client): void {
    this.client = client;
    this.storeUnavailable = false;
  }

  /**
   * Aprende vínculos a partir dos Contacts já buscados pelo roster.
   * Chamado sempre que a lista de membros de um grupo é carregada.
   */
  learnFromContacts(contacts: readonly unknown[]): void {
    let learned = 0;
    for (const contact of contacts) {
      const lid = extractLid(contact);
      const id = (contact as { id?: unknown })?.id;
      const serialized =
        typeof id === 'string'
          ? id
          : typeof (id as { _serialized?: string })?._serialized === 'string'
            ? (id as { _serialized: string })._serialized
            : null;
      if (lid && serialized?.endsWith('@c.us') && !this.map.has(lid)) {
        this.map.set(lid, serialized);
        this.misses.delete(lid);
        learned += 1;
      }
    }
    if (learned) log.debug('vínculos LID aprendidos pelo roster', { learned, total: this.map.size });
  }

  /**
   * Resolve um LID para o chat id `@c.us` correspondente.
   * Devolve null quando não há vínculo conhecido.
   */
  async toContactId(lidRaw: string): Promise<string | null> {
    const lid = normalizeLid(lidRaw);
    const cached = this.map.get(lid);
    if (cached) return cached;
    if (this.misses.has(lid) || this.storeUnavailable) return null;

    const resolved = await this.queryStore(lid);
    if (resolved) {
      this.map.set(lid, resolved);
      return resolved;
    }
    this.misses.add(lid);
    return null;
  }

  /**
   * Última cartada: perguntar ao store do WhatsApp Web pela página.
   *
   * Isto toca APIs internas do WA Web, que mudam sem aviso — daí estar isolado,
   * envolto em try/catch e desativado no primeiro sinal de indisponibilidade.
   */
  private async queryStore(lid: string): Promise<string | null> {
    let page: ReturnType<Client['getPage']>;
    try {
      page = this.client.getPage();
      if (!page) return null;
    } catch {
      this.storeUnavailable = true;
      return null;
    }

    try {
      const result = await page.evaluate((target: string) => {
        const store = (globalThis as { Store?: Record<string, unknown> }).Store;
        if (!store) return null;

        const asSerialized = (value: unknown): string | null => {
          if (typeof value === 'string') return value;
          const s = (value as { _serialized?: unknown })?._serialized;
          return typeof s === 'string' ? s : null;
        };

        // Caminho preferido: utilitário dedicado de LID, quando existe.
        for (const key of ['LidUtils', 'WidToJid', 'LidMap']) {
          const util = store[key] as Record<string, unknown> | undefined;
          if (!util) continue;
          for (const fn of ['getPhoneNumber', 'getPnForLid', 'lidToPn', 'getPn']) {
            const candidate = util[fn];
            if (typeof candidate === 'function') {
              try {
                const out = asSerialized((candidate as (x: string) => unknown).call(util, target));
                if (out && out.endsWith('@c.us')) return out;
              } catch {
                /* tenta o próximo */
              }
            }
          }
        }

        // Alternativa: varrer a coleção de contatos procurando o LID.
        // Compara só a identidade, ignorando o sufixo de dispositivo (":71").
        const identity = (value: string): string =>
          value.replace('@lid', '').split(':')[0] ?? value;
        const wanted = identity(target);

        const contacts = store.Contact as { getModelsArray?: () => unknown[] } | undefined;
        const models = contacts?.getModelsArray?.() ?? [];
        for (const model of models) {
          const m = model as Record<string, unknown>;
          for (const field of ['lid', 'lidId', 'linkedId']) {
            const value = asSerialized(m[field]);
            if (value && identity(value) === wanted) {
              const id = asSerialized(m.id);
              if (id && id.endsWith('@c.us')) return id;
            }
          }
        }
        return null;
      }, lid);

      if (typeof result === 'string' && result.endsWith('@c.us')) {
        log.debug('LID resolvido pelo store', { lid, contactId: result });
        return result;
      }
      return null;
    } catch (error) {
      log.debug('consulta ao store falhou; desistindo dessa via', { error: String(error) });
      this.storeUnavailable = true;
      return null;
    }
  }
}
