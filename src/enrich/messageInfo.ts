/**
 * Lê a confirmação de leitura de uma mensagem enviada pela própria conta —
 * a mesma informação da tela "Dados da mensagem" do WhatsApp Web.
 *
 * ## Por que não basta chamar o open-wa
 *
 * A v4.76 declara duas funções que serviriam:
 *
 *   - `getMessageInfo` — marcada `{@license:insiders@}`, ou seja, paga;
 *   - `getMessageReaders` — sem marca de licença, mas **ausente do `wapi.js`
 *     empacotado**, exatamente como `getPollData`. Ela chega pelo patch remoto,
 *     o que faz a disponibilidade depender de um servidor externo em runtime.
 *
 * Por isso a rota principal aqui é o store do WhatsApp Web pela página do
 * puppeteer, com as duas funções do open-wa como alternativa. A primeira rota
 * que responder vira a preferida; a que falhar é desativada e não é mais
 * tentada.
 *
 * ## Isto continua sendo leitura
 *
 * Nada aqui escreve no grupo. A consulta de "dados da mensagem" é uma pergunta
 * ao servidor **sobre uma mensagem que a própria conta enviou** — é o que o WA
 * Web faz ao abrir aquela tela. Não envia mensagem, não marca nada como lido
 * para ninguém e não altera estado do grupo.
 *
 * ## Diferença crucial em relação a votos de enquete
 *
 * Voto de enquete é cifrado ponta a ponta e só o aparelho principal decifra —
 * daí `probe-polls` ter dado negativo. Confirmação de leitura não é nada disso:
 * é um recibo que o servidor entrega a quem enviou, e chega a todos os
 * dispositivos conectados. Por isso esta via tem chance real de funcionar num
 * aparelho conectado — o que `probe-reads` confirma na sessão de verdade.
 */

import type { Client } from '@open-wa/wa-automate';
import type { ReadReceiptSource } from '../types';
import { createLogger } from '../util/logger';
import { preparePage } from '../util/page';
import { waTimestampToIso } from '../util/phone';

const log = createLogger('message-info');

/**
 * Uma pessoa que abriu a mensagem.
 *
 * Só leitura, nunca entrega: "chegou no aparelho e não foi aberto" não vira
 * métrica nenhuma, e guardar isso custaria espaço numa coleção que já é a de
 * maior cardinalidade do projeto.
 */
export interface Receipt {
  /** Id do WhatsApp de quem leu: `@c.us` ou `@lid`. */
  contactId: string;
  readAt: string | null;
}

export interface MessageInfoResult {
  readers: Receipt[];
  /**
   * Quantos participantes ainda não leram. Zero significa que todo mundo leu e
   * a mensagem pode sair da lista de vigiadas. null = o WhatsApp não informou.
   */
  readRemaining: number | null;
  source: ReadReceiptSource;
}

/** Formato cru devolvido pela página, já achatado em objetos simples. */
interface RawInfo {
  read: Array<{ id: string; t: number | null }>;
  readRemaining: number | null;
  source: 'store-cache' | 'store-query';
}

/**
 * O que o coletor precisa de uma fonte de confirmação de leitura. Existe para
 * que o teste possa substituir o acesso ao WhatsApp por uma fonte de mentira.
 */
export interface MessageInfoSource {
  readonly available: boolean;
  read(messageId: string): Promise<MessageInfoResult | null>;
}

type Route = 'store' | 'getMessageInfo' | 'getMessageReaders';

const ROUTES: Route[] = ['store', 'getMessageInfo', 'getMessageReaders'];

export class MessageInfoReader implements MessageInfoSource {
  /** Rotas que já falharam de forma estrutural e não serão tentadas de novo. */
  private readonly broken = new Set<Route>();
  /** A rota que funcionou da última vez, tentada primeiro nas próximas. */
  private preferred: Route | null = null;
  private announced = false;

  constructor(private client: Client) {}

  setClient(client: Client): void {
    this.client = client;
    this.broken.clear();
    this.preferred = null;
  }

  /** true enquanto ainda houver alguma rota viável. */
  get available(): boolean {
    return ROUTES.some((r) => !this.broken.has(r));
  }

  /**
   * Devolve quem leu a mensagem, ou null quando nenhuma rota respondeu.
   *
   * Nunca lança: sem confirmação de leitura o monitor segue igual.
   */
  async read(messageId: string): Promise<MessageInfoResult | null> {
    const order = this.preferred
      ? [this.preferred, ...ROUTES.filter((r) => r !== this.preferred)]
      : ROUTES;

    for (const route of order) {
      if (this.broken.has(route)) continue;
      const result = await this.tryRoute(route, messageId);
      if (result) {
        // Uma rota só vira a preferida quando entrega informação de verdade.
        // `getMessageReaders` devolvendo lista vazia é indistinguível de "essa
        // função não funciona nesta sessão"; se isso fixasse a preferência, ela
        // sombrearia o store — que é tentado antes justamente por ser melhor.
        const informativo = result.readers.length > 0 || result.readRemaining !== null;
        if (informativo && this.preferred !== route) {
          this.preferred = route;
          if (!this.announced) {
            log.info('confirmação de leitura disponível', { rota: result.source });
            this.announced = true;
          }
        }
        return result;
      }
    }
    return null;
  }

  private async tryRoute(route: Route, messageId: string): Promise<MessageInfoResult | null> {
    switch (route) {
      case 'store':
        return this.fromStore(messageId);
      case 'getMessageInfo':
        return this.fromOpenWa(messageId, 'getMessageInfo');
      case 'getMessageReaders':
        return this.fromReaders(messageId);
      default:
        return null;
    }
  }

  // --- rota 1: store do WA Web ---------------------------------------------

  private async fromStore(messageId: string): Promise<MessageInfoResult | null> {
    let page: ReturnType<Client['getPage']>;
    try {
      page = this.client.getPage();
      if (!page) return null;
    } catch {
      this.broken.add('store');
      return null;
    }

    // Sem isto o `evaluate` abaixo morre com "__name is not defined": as
    // funções aninhadas chegam ao browser com o helper do esbuild, que só
    // existe no processo Node. Ver src/util/page.ts.
    if (!(await preparePage(page))) {
      this.broken.add('store');
      return null;
    }

    let raw: RawInfo | { error: string } | null;
    try {
      raw = (await page.evaluate(async (target: string) => {
        const store = (globalThis as { Store?: Record<string, unknown> }).Store;
        if (!store) return { error: 'sem Store' };

        const serialize = (value: unknown): string | null => {
          if (typeof value === 'string') return value;
          const s = (value as { _serialized?: unknown })?._serialized;
          return typeof s === 'string' ? s : null;
        };

        // Uma coleção do WA Web pode ser array, Collection (getModelsArray) ou
        // expor `models` direto. Aceita as três formas.
        const toArray = (value: unknown): unknown[] => {
          if (!value) return [];
          if (Array.isArray(value)) return value;
          const collection = value as { getModelsArray?: () => unknown[]; models?: unknown[] };
          if (typeof collection.getModelsArray === 'function') return collection.getModelsArray();
          if (Array.isArray(collection.models)) return collection.models;
          return [];
        };

        const pick = (info: Record<string, unknown>, field: string) =>
          toArray(info[field])
            .map((entry) => {
              const e = entry as Record<string, unknown>;
              const id = serialize(e?.id ?? e?.participant ?? entry);
              const t = typeof e?.t === 'number' ? e.t : typeof e?.timestamp === 'number' ? e.timestamp : null;
              return { id, t };
            })
            .filter((e): e is { id: string; t: number | null } => typeof e.id === 'string');

        const normalize = (value: unknown, source: 'store-cache' | 'store-query') => {
          if (!value || typeof value !== 'object') return null;
          const info = value as Record<string, unknown>;
          // `delivery` não é extraído — só serve aqui como prova de que o
          // objeto é mesmo de "dados da mensagem". Array vazio em `read` é
          // resposta legítima (ninguém leu ainda) e passa.
          if (!info.read && !info.delivery) return null;
          return {
            read: pick(info, 'read'),
            readRemaining: typeof info.readRemaining === 'number' ? info.readRemaining : null,
            source,
          };
        };

        const msgs = store.Msg as { get?: (id: string) => unknown } | undefined;
        const msg = (msgs?.get?.(target) ?? null) as Record<string, unknown> | null;
        const key = msg?.id ?? target;

        // Distingue "a API não existe nesta versão" de "a API existe mas não
        // tinha nada para esta mensagem". Só o primeiro caso justifica desistir
        // da rota: uma mensagem recém-enviada, que ninguém leu ainda, cai no
        // segundo e não pode derrubar a via inteira.
        let apiVista = false;

        // 1. cache local: os recibos chegam pelo socket e ficam guardados.
        //    Não custa rede e é o caminho normal depois do primeiro acesso.
        for (const name of ['MsgInfo', 'MessageInfo']) {
          const coll = store[name] as { get?: (id: unknown) => unknown } | undefined;
          if (typeof coll?.get !== 'function') continue;
          apiVista = true;
          try {
            const out = normalize(coll.get(target) ?? coll.get(key), 'store-cache');
            if (out) return out;
          } catch {
            /* tenta o próximo */
          }
        }
        const inline = normalize(msg?.msgInfo ?? msg?.info, 'store-cache');
        if (inline) return inline;

        // 2. consulta ao servidor — o mesmo que a tela "Dados da mensagem" faz.
        const queries: Array<[string, string[]]> = [
          ['MessageInfo', ['sendQueryMsgInfo', 'queryMsgInfo']],
          ['MsgInfo', ['sendQueryMsgInfo', 'queryMsgInfo', 'find']],
          ['Wap', ['queryMsgInfo']],
        ];
        for (const [name, fns] of queries) {
          const mod = store[name] as Record<string, unknown> | undefined;
          if (!mod) continue;
          for (const fn of fns) {
            const candidate = mod[fn];
            if (typeof candidate !== 'function') continue;
            apiVista = true;
            try {
              const res = await (candidate as (k: unknown) => unknown).call(mod, key);
              const out = normalize(res, 'store-query');
              if (out) return out;
            } catch {
              /* tenta a próxima */
            }
          }
        }

        return { error: apiVista ? 'sem-resposta' : 'sem-api' };
      }, messageId)) as RawInfo | { error: string } | null;
    } catch (error) {
      log.debug('consulta ao store falhou; desistindo dessa via', { error: String(error) });
      this.broken.add('store');
      return null;
    }

    if (!raw || 'error' in raw) {
      // Só `sem-api` é estrutural — aí repetir a cada ciclo não levaria a nada.
      // `sem-resposta` é o caso normal de mensagem que ninguém leu ainda, e
      // `sem Store` pode ser sessão ainda subindo: nos dois a rota continua viva.
      if (raw && raw.error === 'sem-api') {
        log.debug('store não expõe API de dados da mensagem nesta versão');
        this.broken.add('store');
      }
      return null;
    }

    return {
      readers: dedupeReceipts(raw.read),
      readRemaining: raw.readRemaining,
      source: raw.source,
    };
  }

  // --- rota 2: helper do open-wa (patch remoto / licença paga) --------------

  private async fromOpenWa(messageId: string, method: 'getMessageInfo'): Promise<MessageInfoResult | null> {
    const api = this.client as unknown as Record<string, unknown>;
    const fn = api[method];
    if (typeof fn !== 'function') {
      this.broken.add('getMessageInfo');
      return null;
    }

    try {
      const info = (await (fn as (id: string) => Promise<unknown>).call(this.client, messageId)) as
        | Record<string, unknown>
        | null;

      // Sem licença, o open-wa NÃO lança: ele devolve a string
      // "ERROR: This feature requires an Insiders license..." (ver
      // `responseWrap` em Client.js) ou `false`, conforme o `onError`. Tratar
      // isso como falha transitória fazia a rota ser tentada de novo a cada
      // mensagem, imprimindo o banner de licença para sempre. Resposta fora do
      // formato aqui é estrutural: desiste da via.
      if (!info || typeof info !== 'object') {
        log.debug('getMessageInfo indisponível (provável licença)', { resposta: String(info) });
        this.broken.add('getMessageInfo');
        return null;
      }

      const read = normalizeInteractions(info.read);
      // `delivery` só como prova de que a resposta tem o formato esperado.
      if (!read && !normalizeInteractions(info.delivery)) return null;

      return {
        readers: dedupeReceipts(read ?? []),
        readRemaining: typeof info.readRemaining === 'number' ? info.readRemaining : null,
        source: 'getMessageInfo',
      };
    } catch (error) {
      // Sem licença o open-wa lança já na chamada. Não insiste.
      log.debug('getMessageInfo indisponível', { error: String(error) });
      this.broken.add('getMessageInfo');
      return null;
    }
  }

  // --- rota 3: getMessageReaders -------------------------------------------

  private async fromReaders(messageId: string): Promise<MessageInfoResult | null> {
    const api = this.client as unknown as Record<string, unknown>;
    const fn = api.getMessageReaders;
    if (typeof fn !== 'function') {
      this.broken.add('getMessageReaders');
      return null;
    }

    try {
      const contacts = (await (fn as (id: string) => Promise<unknown>).call(
        this.client,
        messageId,
      )) as unknown[] | null;
      // Pelo mesmo motivo do `getMessageInfo`: uma resposta que não é array é
      // string de erro ou `false`, e isso não melhora na próxima mensagem.
      if (!Array.isArray(contacts)) {
        log.debug('getMessageReaders devolveu formato inesperado', { resposta: String(contacts) });
        this.broken.add('getMessageReaders');
        return null;
      }

      const readers: Receipt[] = [];
      for (const contact of contacts) {
        const c = contact as Record<string, unknown>;
        const id = serializeId(c?.id) ?? (typeof c?.id === 'string' ? c.id : null);
        if (!id) continue;
        readers.push({
          contactId: id,
          readAt: waTimestampToIso(typeof c.t === 'number' ? c.t : null),
        });
      }
      return { readers, readRemaining: null, source: 'getMessageReaders' };
    } catch (error) {
      log.debug('getMessageReaders indisponível', { error: String(error) });
      this.broken.add('getMessageReaders');
      return null;
    }
  }
}

// --- utilitários ------------------------------------------------------------

function serializeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const s = (value as { _serialized?: unknown })?._serialized;
  return typeof s === 'string' ? s : null;
}

function normalizeInteractions(value: unknown): Array<{ id: string; t: number | null }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ id: string; t: number | null }> = [];
  for (const entry of value) {
    const e = entry as Record<string, unknown>;
    const id = serializeId(e?.id);
    if (!id) continue;
    out.push({ id, t: typeof e.t === 'number' ? e.t : null });
  }
  return out;
}

/**
 * Lista de quem leu, sem repetição.
 *
 * O mesmo contato pode aparecer duas vezes com dispositivos diferentes; fica o
 * registro mais antigo, que é quando a pessoa de fato abriu.
 */
function dedupeReceipts(read: Array<{ id: string; t: number | null }>): Receipt[] {
  const byId = new Map<string, Receipt>();
  for (const entry of read) {
    const readAt = waTimestampToIso(entry.t);
    const existing = byId.get(entry.id);
    if (existing && existing.readAt && readAt && existing.readAt <= readAt) continue;
    byId.set(entry.id, { contactId: entry.id, readAt });
  }
  return [...byId.values()];
}
