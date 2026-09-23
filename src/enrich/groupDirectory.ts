/**
 * Metadados de grupo vindos do servidor, não da memória do WA Web.
 *
 * `getGroupMembers`, `getGroupInfo` e `getChatById` do open-wa leem
 * `Store.Chat`, que no aparelho vinculado é uma fração da conta (17 de 179
 * grupos em 16/09/2026). Para os que ficam de fora, o WAPI responde
 * "Group chat does not exist in this session" e o snapshot sai sem ninguém.
 * `WAWebGroupQueryJob.queryAllGroups()` é a consulta "participating" que o
 * próprio WA Web usa e devolve todos os grupos com participantes, numa ida só.
 * É leitura: não altera grupo nenhum.
 */

import type { Client } from '@open-wa/wa-automate';
import { createLogger } from '../util/logger';
import { preparePage } from '../util/page';
import { localIso } from '../util/time';
import { isLid, normalizeLid } from './lid';

const log = createLogger('group-directory');

/** Entre duas idas bem-sucedidas ao servidor, mesmo com `invalidate()`. */
const INTERVALO_MINIMO_MS = 5 * 60 * 1000;
/** Depois de falha que não é limite (página instável, módulo sumido). */
const PAUSA_FALHA_MS = 60 * 1000;
/** Depois de 429. O servidor não diz quanto esperar; 15 min é conservador. */
const PAUSA_LIMITE_MS = 15 * 60 * 1000;

export interface DirectoryParticipant {
  /** `@c.us` quando o servidor dá o telefone; `@lid` só quando não dá. */
  id: string;
  lid: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface DirectoryGroup {
  id: string;
  subject: string | null;
  description: string | null;
  owner: string | null;
  /** null quando algum participante veio sem id utilizável. */
  participants: DirectoryParticipant[] | null;
  /** O grupo está em `Store.Chat`, onde as chamadas do open-wa funcionam. */
  inStore: boolean;
}

/** O que o Roster precisa; separado para os testes não dependerem de página. */
export interface GroupSource {
  get(groupId: string): Promise<DirectoryGroup | null>;
  invalidate(): void;
}

interface PageLike {
  evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
}

/** Texto de um id que pode vir como string, Wid ou objeto com `id`. */
export function idText(x: unknown): string {
  if (typeof x === 'string') return x;
  const o = x as { _serialized?: unknown; id?: unknown } | null;
  if (o && typeof o._serialized === 'string') return o._serialized;
  if (o && o.id !== undefined && o.id !== x) return idText(o.id);
  return '';
}

/**
 * Normaliza um grupo cru do `queryAllGroups`. Função pura, para teste.
 *
 * O servidor entrega todo participante com `id` em `@lid` e, quase sempre, o
 * telefone em `phoneNumber` (5106 de 5414 em 16/09/2026). O id do participante
 * é o `@c.us` sempre que existe, porque é o que `getGroupMembers` devolve e o
 * que a reconciliação compara: uma lista em `@lid` para quem tem telefone
 * viraria êxodo em massa no dia em que o grupo entrasse no store.
 *
 * Quem vem sem telefone (os outros 308 trazem `username`: o número está
 * escondido) entra pelo `@lid`. Para essa pessoa não existe `@c.us` em lugar
 * nenhum, então o `@lid` é a identidade estável dela — e o Ingestor já sabe
 * tratá-lo (`lid:` provisório em `mongo/identity.ts`). Descartar a lista por
 * causa dela custava o grupo inteiro.
 *
 * O formato não é documentado e muda entre builds — o tipo declarado não é
 * evidência (ver CLAUDE.md). Por isso o telefone é procurado em todos os
 * campos plausíveis e o admin nas duas formas conhecidas.
 */
export function toDirectoryGroup(raw: Record<string, unknown>, inStore: boolean): DirectoryGroup | null {
  const id = idText(raw.id);
  if (!id.endsWith('@g.us')) return null;

  let participants: DirectoryParticipant[] | null = [];
  for (const p of Array.isArray(raw.participants) ? (raw.participants as unknown[]) : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    const cus = [r.phoneNumber, r.id, r.pn, r.jid].map(idText).find((c) => c.endsWith('@c.us'));
    const bruto = [r.lid, r.id].map(idText).find((c) => isLid(c));
    const lid = bruto ? normalizeLid(bruto) : null;
    const participantId = cus ?? lid;
    if (!participantId) {
      participants = null;
      break;
    }
    const papel = String(r.admin ?? r.type ?? '');
    const isSuperAdmin = r.isSuperAdmin === true || papel === 'superadmin';
    participants.push({
      id: participantId,
      lid,
      isAdmin: isSuperAdmin || r.isAdmin === true || papel === 'admin',
      isSuperAdmin,
    });
  }

  const texto = (v: unknown): string | null => {
    if (typeof v === 'string') return v || null;
    const o = v as { desc?: unknown } | null;
    return o && typeof o.desc === 'string' ? o.desc || null : null;
  };

  return {
    id,
    subject: texto(raw.subject),
    description: texto(raw.desc ?? raw.description),
    owner: idText(raw.owner) || null,
    participants,
    inStore,
  };
}

export class GroupDirectory implements GroupSource {
  private grupos: Map<string, DirectoryGroup> | null = null;
  private buscadoEm = 0;
  private emVoo: Promise<Map<string, DirectoryGroup> | null> | null = null;
  private avisouIndisponivel = false;
  /**
   * Antes disto, ninguém vai ao servidor — nem `invalidate()`. É a consulta
   * mais pesada que o monitor faz (a conta inteira, ~5 mil participantes), e
   * em 23/09/2026 o servidor passou a responder 429 `rate-overlimit`: cada
   * entrada de participante invalidava o diretório e cada `get()` depois de
   * uma falha consultava de novo. Uma lista de alguns minutos atrás é tão boa
   * quanto a de agora para o que ela serve (quem está em cada grupo; a
   * reconciliação de membros corrige o resto).
   */
  private proximaIdaEm = 0;

  constructor(
    private client: Client,
    private readonly ttlMs: number,
  ) {}

  setClient(client: Client): void {
    this.client = client;
    this.invalidate();
  }

  /**
   * A próxima consulta que o intervalo mínimo permitir vai ao servidor.
   * Chamado quando participantes mudam — o que num grupo grande é várias
   * vezes por hora, por isso não fura `proximaIdaEm`.
   */
  invalidate(): void {
    this.buscadoEm = 0;
  }

  async get(groupId: string): Promise<DirectoryGroup | null> {
    const grupos = await this.carregar();
    return grupos?.get(groupId) ?? null;
  }

  /** Todos os grupos da conta, ou null se o servidor não respondeu. */
  async all(): Promise<DirectoryGroup[] | null> {
    const grupos = await this.carregar();
    return grupos ? [...grupos.values()] : null;
  }

  private async carregar(): Promise<Map<string, DirectoryGroup> | null> {
    if (Date.now() < this.proximaIdaEm) return this.grupos;
    if (this.grupos && Date.now() - this.buscadoEm < this.ttlMs) return this.grupos;
    // Um snapshot por grupo no boot pede o diretório 161 vezes seguidas; todas
    // esperam a mesma ida ao servidor.
    this.emVoo ??= this.buscar().finally(() => {
      this.emVoo = null;
    });
    return this.emVoo;
  }

  private async buscar(): Promise<Map<string, DirectoryGroup> | null> {
    const resultado = await this.consultar();
    if (resultado === 'limite') {
      this.proximaIdaEm = Date.now() + PAUSA_LIMITE_MS;
      log.warn('servidor limitou a consulta de grupos (429); pausando', {
        ate: localIso(new Date(this.proximaIdaEm)),
      });
      return this.grupos;
    }
    if (resultado) {
      this.grupos = resultado;
      this.buscadoEm = Date.now();
      this.proximaIdaEm = Date.now() + INTERVALO_MINIMO_MS;
      return resultado;
    }
    this.proximaIdaEm = Date.now() + PAUSA_FALHA_MS;
    // A lista anterior, se houver, ainda é melhor que nenhuma.
    return this.grupos;
  }

  /**
   * Logo depois do `create()` o WA Web ainda está sincronizando e o
   * `queryAllGroups` lança um erro minificado (`t: t`, em 23/09/2026, 160 ms
   * depois de "sessão pronta"). Algumas tentativas espaçadas cobrem página
   * ainda instável. 429 (`rate-overlimit`) é outra coisa: o servidor recusou,
   * e repetir em segundos só prolonga o bloqueio — sai na hora.
   */
  private async consultar(): Promise<Map<string, DirectoryGroup> | null | 'limite'> {
    const esperas = [0, 5_000, 15_000];
    for (const [i, espera] of esperas.entries()) {
      if (espera) await new Promise((r) => setTimeout(r, espera));
      const r = await this.consultarUmaVez();
      if (r !== 'erro') return r;
      if (i < esperas.length - 1) log.info('repetindo consulta de grupos ao servidor', { tentativa: i + 2 });
    }
    return null;
  }

  private async consultarUmaVez(): Promise<Map<string, DirectoryGroup> | null | 'erro' | 'limite'> {
    let page: PageLike | null = null;
    try {
      page = this.client.getPage() as unknown as PageLike;
    } catch {
      page = null;
    }
    if (!page || !(await preparePage(page))) return null;

    try {
      const crus = (await page.evaluate(async () => {
        const g = globalThis as {
          Store?: { Chat?: { get?: (id: string) => unknown } };
          require?: (n: string) => unknown;
        };
        const mod = g.require?.('WAWebGroupQueryJob') as
          | { queryAllGroups?: () => Promise<unknown> }
          | undefined;
        if (typeof mod?.queryAllGroups !== 'function') return null;
        let res: unknown;
        try {
          res = await mod.queryAllGroups();
        } catch (e) {
          // O erro do WA Web é minificado: `String(e)` dá "t: t". O que
          // identifica a falha está em campos próprios e no stack.
          const o = (e ?? {}) as Record<string, unknown> & { stack?: unknown };
          const campos: Record<string, string> = {};
          for (const k of Object.getOwnPropertyNames(o).slice(0, 15)) {
            if (k === 'stack') continue;
            try {
              campos[k] = String(o[k]).slice(0, 120);
            } catch {
              /* getter que lança */
            }
          }
          return {
            erro: {
              texto: String(e).slice(0, 120),
              construtor: (o as { constructor?: { name?: string } }).constructor?.name ?? null,
              campos,
              stack: String(o.stack ?? '').split('\n').slice(0, 4).join(' | '),
            },
          };
        }
        if (!Array.isArray(res)) return null;

        const texto = (x: unknown): string => {
          if (typeof x === 'string') return x;
          const o = x as { _serialized?: unknown; id?: unknown } | null;
          if (o && typeof o._serialized === 'string') return o._serialized;
          if (o && o.id !== undefined && o.id !== x) return texto(o.id);
          return '';
        };
        // Só o que interessa, já achatado: Wid e models não atravessam o
        // `evaluate` inteiros.
        return res.map((grupo: Record<string, unknown>) => {
          const id = texto(grupo.id);
          const desc = grupo.desc ?? grupo.description;
          return {
            inStore: Boolean(id && g.Store?.Chat?.get?.(id)),
            raw: {
              id,
              subject: typeof grupo.subject === 'string' ? grupo.subject : null,
              desc:
                typeof desc === 'string'
                  ? desc
                  : typeof (desc as { desc?: unknown })?.desc === 'string'
                    ? (desc as { desc: string }).desc
                    : null,
              owner: texto(grupo.owner),
              participants: Array.isArray(grupo.participants)
                ? grupo.participants.map((p: Record<string, unknown>) => ({
                    id: texto(p?.id),
                    phoneNumber: texto(p?.phoneNumber),
                    pn: texto(p?.pn),
                    jid: texto(p?.jid),
                    lid: texto(p?.lid),
                    admin: typeof p?.admin === 'string' ? p.admin : null,
                    type: typeof p?.type === 'string' ? p.type : null,
                    isAdmin: p?.isAdmin === true,
                    isSuperAdmin: p?.isSuperAdmin === true,
                  }))
                : [],
            },
          };
        });
      })) as Array<{ inStore: boolean; raw: Record<string, unknown> }> | { erro: unknown } | null;

      if (crus && !Array.isArray(crus)) {
        const erro = crus.erro as { campos?: Record<string, string> };
        if (erro.campos?.statusCode === '429' || erro.campos?.message === 'rate-overlimit') return 'limite';
        log.warn('consulta de grupos ao servidor falhou', erro);
        return 'erro';
      }
      if (!crus) {
        if (!this.avisouIndisponivel) {
          log.warn('WAWebGroupQueryJob.queryAllGroups indisponível; ver `npm run probe-groups`');
          this.avisouIndisponivel = true;
        }
        return null;
      }

      const grupos = new Map<string, DirectoryGroup>();
      for (const { inStore, raw } of crus) {
        const grupo = toDirectoryGroup(raw, inStore);
        if (grupo) grupos.set(grupo.id, grupo);
      }
      const todos = [...grupos.values()];
      // Nenhum em memória não é plausível (a conta tem conversas abertas): é a
      // checagem de `Store.Chat` que falhou. Sem saber, todos seguem pelo
      // caminho do store, que traz nome — pular o store seria pior.
      if (todos.length > 0 && todos.every((g) => !g.inStore)) {
        log.warn('não foi possível checar quais grupos estão em memória; assumindo todos');
        for (const g of todos) g.inStore = true;
      }
      log.info('grupos consultados no servidor', {
        total: grupos.size,
        foraDaMemoria: todos.filter((g) => !g.inStore).length,
        listasDescartadas: todos.filter((g) => g.participants === null).length,
        participantesSemTelefone: todos.reduce(
          (n, g) => n + (g.participants ?? []).filter((p) => !p.id.endsWith('@c.us')).length,
          0,
        ),
      });

      return grupos;
    } catch (error) {
      log.warn('consulta de grupos ao servidor falhou', { error: String(error) });
      return 'erro';
    }
  }
}
