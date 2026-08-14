/**
 * Carrega histórico de um chat para dentro do store do WhatsApp Web.
 *
 * ## Por que isto existe
 *
 * `getAllMessagesInChat` só enxerga o que já está na memória do WA Web. Quem
 * traz mensagem do aparelho/servidor para essa memória é a família
 * `loadEarlierMsgs` — e é justamente ela que quebrou.
 *
 * As duas funções do open-wa terminam na mesma chamada:
 *
 *     WAPI.loadEarlierMessagesTillDate → found.loadEarlierMsgs()
 *     WAPI.loadEarlierMessages         → chat.loadEarlierMsgs()
 *
 * Na build atual do WA Web, `chat.loadEarlierMsgs()` estoura dentro do bundle
 * do próprio WhatsApp com `Cannot read properties of undefined (reading
 * 'waitForChatLoading')`. Como a "paginação manual" de reserva do backfill
 * chamava exatamente a função que falhou, não havia reserva nenhuma: os dois
 * caminhos morriam juntos e o monitor ficava só com a captura ao vivo.
 *
 * ## A estratégia
 *
 * O mesmo desenho do `MessageInfoReader`: várias rotas candidatas, a primeira
 * que responder vira a preferida, e o laço de paginação fica no Node — não no
 * browser. Paginar dentro de um único `page.evaluate` arriscaria estourar o
 * timeout do protocolo num grupo grande, e não daria log de progresso.
 *
 * Quando nenhuma rota funciona, devolve um diagnóstico com os módulos que o
 * store realmente expõe. Sem isso, descobrir o nome novo exigiria um ciclo de
 * tentativa e erro com sessão real a cada palpite.
 */

import type { Client } from '@open-wa/wa-automate';
import { createLogger } from './logger';
import { preparePage } from './page';

const log = createLogger('history');

/** Estado do chat depois de uma tentativa de carga. */
interface StepResult {
  ok: boolean;
  /** Quantas mensagens há no store do chat agora. */
  loaded: number;
  /** Timestamp (segundos) da mais antiga carregada, ou null. */
  oldest: number | null;
  /** O WhatsApp já avisou que não há mais nada anterior. */
  noEarlier: boolean;
  route: string | null;
  error?: string;
  /** true quando nenhuma rota existe — aí não adianta insistir. */
  fatal?: boolean;
  /** Métodos que o store expõe, para descobrir o nome certo sem adivinhar. */
  diag?: string[];
}

export interface LoadResult {
  ok: boolean;
  loaded: number;
  oldest: number | null;
  route: string | null;
  /** Parou porque cobriu a janela pedida. */
  covered: boolean;
  steps: number;
}

export class HistoryLoader {
  private route: string | null = null;
  private broken = false;

  constructor(private client: Client) {}

  setClient(client: Client): void {
    this.client = client;
    this.route = null;
    this.broken = false;
  }

  /**
   * Pagina até cobrir `sinceMs`, esgotar o histórico ou bater no teto.
   * Nunca lança: sem histórico o monitor segue capturando ao vivo.
   */
  async loadUntil(chatId: string, sinceMs: number, maxSteps = 60): Promise<LoadResult> {
    const sinceSec = Math.floor(sinceMs / 1000);
    const vazio: LoadResult = {
      ok: false, loaded: 0, oldest: null, route: null, covered: false, steps: 0,
    };
    if (this.broken) return vazio;

    let last: StepResult | null = null;
    let steps = 0;
    let previousLoaded = -1;

    for (; steps < maxSteps; steps += 1) {
      const step = await this.step(chatId);
      if (!step.ok) {
        if (step.fatal) {
          log.error('nenhuma rota de carregamento de histórico funcionou', {
            erro: step.error,
            storeExpoe: step.diag,
          });
          this.broken = true;
        }
        return { ...vazio, steps, loaded: last?.loaded ?? 0, oldest: last?.oldest ?? null };
      }

      last = step;
      if (this.route !== step.route) {
        this.route = step.route;
        log.info('rota de histórico em uso', { rota: step.route });
      }

      // Já cobriu a janela pedida.
      if (step.oldest !== null && step.oldest <= sinceSec) break;
      // O WhatsApp não tem mais nada anterior para dar.
      if (step.noEarlier) break;
      // Parou de progredir mesmo depois da espera dentro do passo. Insistir só
      // gastaria chamada — mas o diagnóstico sai, porque parar antes de cobrir
      // a janela costuma significar que a rota certa é outra.
      if (step.loaded === previousLoaded) {
        log.warn('carregamento estagnou antes de cobrir a janela', {
          chatId,
          mensagens: step.loaded,
          rota: step.route,
          storeExpoe: step.diag,
        });
        break;
      }
      previousLoaded = step.loaded;
    }

    return {
      ok: true,
      loaded: last?.loaded ?? 0,
      oldest: last?.oldest ?? null,
      route: this.route,
      covered: last?.oldest !== null && last?.oldest !== undefined && last.oldest <= sinceSec,
      steps,
    };
  }

  /** Uma rodada de carregamento. */
  private async step(chatId: string): Promise<StepResult> {
    const falha = (error: string): StepResult => ({
      ok: false, loaded: 0, oldest: null, noEarlier: false, route: null, error,
    });

    let page: ReturnType<Client['getPage']>;
    try {
      page = this.client.getPage();
      if (!page) return falha('sem página');
    } catch {
      return falha('sem página');
    }
    if (!(await preparePage(page))) return falha('página não aceitou o shim');

    try {
      return (await page.evaluate(
        async (id: string, preferida: string | null) => {
          const store = (globalThis as { Store?: Record<string, unknown> }).Store;
          if (!store) {
            return { ok: false, loaded: 0, oldest: null, noEarlier: false, route: null, error: 'sem Store' };
          }

          const chats = store.Chat as { get?: (id: string) => unknown } | undefined;
          const chat = chats?.get?.(id) as Record<string, unknown> | undefined;
          if (!chat) {
            return { ok: false, loaded: 0, oldest: null, noEarlier: false, route: null, error: 'chat fora do store' };
          }

          const modelos = (): Array<Record<string, unknown>> => {
            const collection = chat.msgs as
              | { getModelsArray?: () => unknown[]; models?: unknown[] }
              | undefined;
            const list = collection?.getModelsArray?.() ?? collection?.models ?? [];
            return list as Array<Record<string, unknown>>;
          };

          const maisAntiga = (): number | null => {
            let min: number | null = null;
            for (const m of modelos()) {
              const t = typeof m?.t === 'number' ? m.t : null;
              // t === 0 aparece em notificações de sistema e derrubaria o mínimo.
              if (t && t > 0 && (min === null || t < min)) min = t;
            }
            return min;
          };

          const semAnteriores = (): boolean =>
            Boolean(
              (chat.msgs as { msgLoadState?: { noEarlierMsgs?: boolean } } | undefined)
                ?.msgLoadState?.noEarlierMsgs,
            );

          const conversation = store.ConversationMsgs as Record<string, unknown> | undefined;

          // A função de paginar não sumiu: ela saiu do model do chat e virou um
          // módulo próprio. O `Store` que o open-wa monta não a conhece, mas o
          // registro de módulos do WA Web sim.
          let chatLoad: Record<string, unknown> | undefined;
          try {
            const req = (globalThis as { require?: (n: string) => unknown }).require;
            chatLoad = req?.('WAWebChatLoadMessages') as Record<string, unknown> | undefined;
          } catch {
            /* build sem esse módulo */
          }

          const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

          /**
           * Nomes de função de carga que existem de fato, para diagnóstico.
           * Usa `getOwnPropertyNames` + cadeia de protótipos: `Object.keys` em
           * módulo do WA Web ou em model devolve [] mesmo com a função lá, e foi
           * isso que fez o diagnóstico anterior sair vazio.
           */
          const expoe = (): string[] => {
            const nomes: string[] = [];
            for (const [rotulo, alvo] of [
              ['WAWebChatLoadMessages', chatLoad],
              ['ConversationMsgs', conversation],
              ['chat', chat],
            ] as Array<[string, Record<string, unknown> | undefined]>) {
              if (!alvo) continue;
              let atual: object | null = alvo;
              for (let nivel = 0; atual && nivel < 4; nivel += 1) {
                for (const chave of Object.getOwnPropertyNames(atual)) {
                  if (!/load|fetch|earlier|initial/i.test(chave)) continue;
                  try {
                    if (typeof alvo[chave] === 'function') nomes.push(`${rotulo}.${chave}`);
                  } catch {
                    /* getters podem lançar */
                  }
                }
                atual = Object.getPrototypeOf(atual) as object | null;
              }
            }
            return [...new Set(nomes)].slice(0, 40);
          };

          // Ordem: a via desta build primeiro; as antigas depois, porque ainda
          // funcionam em versões mais velhas do WA Web.
          //
          // Cada rota é [nome, objeto, método, argumentos] em vez de uma função
          // pronta. Não é preciosismo: antes eu embrulhava a chamada em
          // `async () => alvo?.metodo?.()`, e uma função async SEMPRE devolve
          // Promise — nunca `undefined`. A checagem "esta rota existe?" nunca
          // disparava, e o carregador anunciava sucesso numa rota inexistente
          // sem ter chamado nada.
          const rotas: Array<[string, Record<string, unknown> | undefined, string, unknown[]]> = [
            ['WAWebChatLoadMessages.loadEarlierMsgs', chatLoad, 'loadEarlierMsgs', [chat]],
            ['ConversationMsgs.loadEarlierMsgs', conversation, 'loadEarlierMsgs', [chat]],
            ['chat.loadEarlierMsgs', chat, 'loadEarlierMsgs', []],
          ];

          // A preferida vai primeiro, para não repetir descoberta a cada passo.
          const ordenadas = preferida
            ? [...rotas].sort((a, b) => (a[0] === preferida ? -1 : b[0] === preferida ? 1 : 0))
            : rotas;

          let ultimoErro = '';
          for (const [nome, alvo, metodo, args] of ordenadas) {
            const fn = alvo?.[metodo];
            if (typeof fn !== 'function') continue; // rota inexistente nesta build
            try {
              const antes = modelos().length;
              await (fn as (...a: unknown[]) => unknown).apply(alvo, args);

              // A promessa resolve ANTES de as mensagens entrarem no store: a
              // carga é assíncrona. Ler o tamanho na hora fazia o laço concluir
              // "não progrediu" e parar na primeira página — foi o que limitou
              // um grupo a 54 mensagens e outro a nenhuma.
              for (let i = 0; i < 12 && modelos().length === antes && !semAnteriores(); i += 1) {
                await dormir(150);
              }

              return {
                ok: true,
                loaded: modelos().length,
                oldest: maisAntiga(),
                noEarlier: semAnteriores(),
                route: nome,
                diag: expoe(),
              };
            } catch (e) {
              ultimoErro = String(e);
            }
          }

          // Fracasso total: devolve os métodos de carga que existem de fato,
          // para descobrir o nome novo sem outro ciclo de tentativa e erro.
          return {
            ok: false,
            loaded: modelos().length,
            oldest: maisAntiga(),
            noEarlier: false,
            route: null,
            error: ultimoErro || 'nenhuma rota existe nesta build',
            fatal: true,
            diag: expoe(),
          };
        },
        chatId,
        this.route,
      )) as StepResult;
    } catch (error) {
      return falha(String(error));
    }
  }
}
