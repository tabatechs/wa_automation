/**
 * Diagnóstico: por que o histórico não carrega?
 *
 * Uso:
 *   npm run probe-history            # primeiro grupo da whitelist
 *   npm run probe-history -- 1       # segundo grupo
 *
 * As funções de histórico do open-wa quebraram (ver CLAUDE.md), e a substituta
 * óbvia — `Store.ConversationMsgs.loadEarlierMsgs` — é aceita pelo WA Web mas
 * não traz mensagem nenhuma em alguns chats. Adivinhar o nome certo custa uma
 * execução com sessão real por palpite, então este script para de adivinhar:
 * lista o que o store expõe DE FATO e testa cada candidata isoladamente,
 * medindo quantas mensagens entraram.
 *
 * Só leitura: não envia nada, não abre conversa para o outro lado ver.
 */

import { loadConfig } from '../config';
import { startSession, stopSession } from '../session';
import { createLogger, setLogLevel } from '../util/logger';
import { preparePage } from '../util/page';

const log = createLogger('probe-history');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const indice = Number(process.argv[2] ?? '0');
  const group = config.groups[indice];
  if (!group) {
    log.error('grupo não encontrado na whitelist', { indice, total: config.groups.length });
    process.exit(1);
  }

  const client = await startSession(config);
  try {
    const page = client.getPage();
    if (!page || !(await preparePage(page))) {
      log.error('sem página utilizável');
      return;
    }

    const desde = Math.floor((Date.now() - config.backfillDays * 24 * 3600e3) / 1000);
    const relatorio = (await page.evaluate(
      async (chatId: string, sinceSec: number) => {
        const store = (globalThis as { Store?: Record<string, unknown> }).Store;
        if (!store) return { erro: 'sem Store' };

        const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

        /**
         * Nomes de função de um objeto, incluindo os não-enumeráveis e os da
         * cadeia de protótipos. `Object.keys` sozinho devolve [] em módulo do
         * WA Web e em model do Backbone — foi por isso que o diagnóstico
         * anterior saiu vazio mesmo com a função existindo.
         */
        const funcoes = (alvo: unknown, filtro: RegExp): string[] => {
          if (!alvo || (typeof alvo !== 'object' && typeof alvo !== 'function')) return [];
          const nomes = new Set<string>();
          let atual: object | null = alvo as object;
          for (let nivel = 0; atual && nivel < 4; nivel += 1) {
            for (const chave of Object.getOwnPropertyNames(atual)) {
              if (!filtro.test(chave)) continue;
              try {
                if (typeof (alvo as Record<string, unknown>)[chave] === 'function') nomes.add(chave);
              } catch {
                /* getters podem lançar */
              }
            }
            atual = Object.getPrototypeOf(atual) as object | null;
          }
          return [...nomes].slice(0, 60);
        };

        const chats = store.Chat as { get?: (id: string) => unknown } | undefined;
        const chat = chats?.get?.(chatId) as Record<string, unknown> | undefined;
        if (!chat) return { erro: 'chat fora do store' };

        const colecao = () =>
          chat.msgs as
            | {
                getModelsArray?: () => unknown[];
                models?: unknown[];
                msgLoadState?: Record<string, unknown>;
              }
            | undefined;

        const quantas = (): number => {
          const c = colecao();
          return (c?.getModelsArray?.() ?? c?.models ?? []).length;
        };

        const maisAntiga = (): number | null => {
          const c = colecao();
          const models = (c?.getModelsArray?.() ?? c?.models ?? []) as Array<Record<string, unknown>>;
          let min: number | null = null;
          for (const m of models) {
            const t = typeof m?.t === 'number' ? m.t : null;
            if (t && t > 0 && (min === null || t < min)) min = t;
          }
          return min;
        };

        const estado = () => {
          try {
            return JSON.parse(JSON.stringify(colecao()?.msgLoadState ?? null));
          } catch {
            return null;
          }
        };

        const conversation = store.ConversationMsgs as Record<string, unknown> | undefined;
        const cmd = store.Cmd as Record<string, unknown> | undefined;

        // --- varredura do registro de módulos --------------------------------
        //
        // O `Store` é um objeto que o open-wa monta apontando para módulos com
        // nomes que ele conhece. Nesta build o WhatsApp renomeou tudo para
        // `WAWeb*`, então o que interessa pode existir e não estar no `Store`.
        // O registro real fica em `require('__debug').modulesMap` nas versões
        // 2.3000+, que é o caso aqui.
        const modulos: Array<{ id: string; funcoes: string[] }> = [];
        let nomesDeModulo: string[] = [];
        let totalModulos = 0;
        try {
          const req = (globalThis as { require?: (n: string) => unknown }).require;
          const debug = req?.('__debug') as { modulesMap?: Record<string, unknown> } | undefined;
          const mapa = debug?.modulesMap ?? {};
          const chaves = Object.keys(mapa);
          totalModulos = chaves.length;

          // 1. só os NOMES, sem tocar em exports: inicializar módulo à toa pode
          //    ter efeito colateral, e o nome já diz muito nesta build (tudo
          //    virou `WAWeb*`).
          // Sem exigir "msg" grudado: esta build escreve "Messages" por extenso
          // em vários módulos, e o filtro anterior deixava passar justamente os
          // que interessam (um `WAWebChatLoadMessages` não casava com `msgload`).
          nomesDeModulo = chaves
            .filter((id) =>
              /(load|fetch|sync|pagin|query).{0,12}(msg|message)|(msg|message).{0,12}(load|fetch|pagin|query)|earlier|older|around/i.test(
                id,
              ),
            )
            .slice(0, 80);

          // 2. exports de quem JÁ está inicializado, com filtro largo.
          const alvo = /earlier|older|previous|history|loadmsg|msgload|fetch|pagin/i;
          for (const id of chaves) {
            try {
              const mod = mapa[id] as { exports?: Record<string, unknown>; isInitialized?: boolean } | undefined;
              const exports = mod?.exports;
              if (!exports) continue;
              const funcoes = Object.getOwnPropertyNames(exports).filter((k) => {
                if (!alvo.test(k)) return false;
                try {
                  return typeof exports[k] === 'function';
                } catch {
                  return false;
                }
              });
              if (funcoes.length) modulos.push({ id, funcoes });
            } catch {
              /* módulo não inspecionável */
            }
          }
        } catch {
          /* sem require: fica só o inventário do Store */
        }

        // --- exports dos módulos que sobraram como suspeitos -----------------
        const exportsDe: Record<string, string[]> = {};
        try {
          const req = (globalThis as { require?: (n: string) => unknown }).require;
          const alvos = [
            'WAWebChatLoadMessages',
            'WAWebFetchMessagesInThread',
            'WAWebDBQueryChatVisibleMessageHelper',
            'WAWebChatMsgsCollection',
          ];
          for (const id of alvos) {
            try {
              const mod = req?.(id) as Record<string, unknown> | undefined;
              if (!mod) continue;
              // Nome + aridade: a aridade é o que permite adivinhar a assinatura
              // sem sair chamando função desconhecida numa conta real.
              exportsDe[id] = Object.getOwnPropertyNames(mod)
                .map((k) => {
                  try {
                    const v = mod[k];
                    return typeof v === 'function' ? `${k}/${(v as () => void).length}` : null;
                  } catch {
                    return null;
                  }
                })
                .filter((x): x is string => x !== null)
                .slice(0, 40);
            } catch (e) {
              exportsDe[id] = [`ERRO: ${String(e).slice(0, 80)}`];
            }
          }
        } catch {
          /* sem require */
        }

        // --- o histórico pode estar no banco local ---------------------------
        //
        // Se o aparelho já sincronizou as mensagens para o IndexedDB, dá para
        // ler direto e não depender da máquina de paginação do WA Web.
        const bancos: Array<{ nome: string; stores?: string[]; erro?: string }> = [];
        // Tipagem estrutural mínima: o tsconfig do projeto não inclui a lib DOM.
        interface PedidoIdb {
          result: { objectStoreNames: ArrayLike<string>; close: () => void };
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        }
        interface FabricaIdb {
          databases?: () => Promise<Array<{ name?: string }>>;
          open: (nome: string) => PedidoIdb;
        }

        try {
          const idb = (globalThis as { indexedDB?: FabricaIdb }).indexedDB;
          const lista = (await idb?.databases?.()) ?? [];
          for (const info of lista.slice(0, 12)) {
            const nome = String(info.name ?? '');
            if (!nome || !idb) continue;
            try {
              const stores = await new Promise<string[]>((resolve, reject) => {
                const pedido = idb.open(nome);
                pedido.onsuccess = () => {
                  const db = pedido.result;
                  const nomes = Array.from(db.objectStoreNames) as string[];
                  db.close();
                  resolve(nomes);
                };
                pedido.onerror = () => reject(new Error('open falhou'));
                setTimeout(() => reject(new Error('timeout')), 3000);
              });
              bancos.push({ nome, stores: stores.filter((s) => /message|msg|chat/i.test(s)) });
            } catch (e) {
              bancos.push({ nome, erro: String(e).slice(0, 80) });
            }
          }
        } catch {
          /* sem IndexedDB acessível */
        }

        // --- inventário -----------------------------------------------------
        const inventario = {
          totalModulos,
          exportsDe,
          nomesDeModuloSuspeitos: nomesDeModulo,
          modulosComCargaDeMensagem: modulos.slice(0, 30),
          bancosLocais: bancos,
          todasAsFuncoesDaColecaoDeMsgs: funcoes(colecao(), /./),
          modulosDoStore: Object.getOwnPropertyNames(store)
            .filter((k) => /conv|msg|chat|cmd|load/i.test(k))
            .slice(0, 60),
          conversationMsgs: funcoes(conversation, /./),
          cmdRelevante: funcoes(cmd, /open|chat|msg|load/i),
          chatRelevante: funcoes(chat, /load|msg|fetch/i),
          colecaoMsgs: funcoes(colecao(), /load|fetch|earlier/i),
        };

        // --- teste das candidatas, uma a uma ---------------------------------
        // `loadEarlierMsgs` não existe mais em lugar nenhum desta build — nem no
        // Store, nem em módulo, nem no model. O que sobrou são os primitivos da
        // própria coleção de mensagens.
        const col = () => colecao() as unknown as Record<string, unknown>;
        const chamar = (alvo: unknown, metodo: string, ...args: unknown[]): unknown => {
          const obj = alvo as Record<string, unknown> | undefined;
          const fn = obj?.[metodo];
          if (typeof fn !== 'function') return undefined;
          return (fn as (...a: unknown[]) => unknown).apply(obj, args);
        };

        // `WAWebChatLoadMessages.loadEarlierMsgs` existe e é chamada, mas estoura
        // com `undefined.waitForChatLoading` — sinal de que ela procura o chat
        // por outra chave e não acha. Testando o que ela realmente espera.
        let chatLoad: Record<string, unknown> | undefined;
        try {
          const req = (globalThis as { require?: (n: string) => unknown }).require;
          chatLoad = req?.('WAWebChatLoadMessages') as Record<string, unknown> | undefined;
        } catch {
          /* sem módulo */
        }

        const candidatas: Array<[string, () => unknown]> = [
          ['ChatLoadMessages.loadEarlierMsgs(chat)', () => chamar(chatLoad, 'loadEarlierMsgs', chat)],
          [
            'ChatLoadMessages.loadEarlierMsgs(chat.id)',
            () => chamar(chatLoad, 'loadEarlierMsgs', chat.id),
          ],
          [
            'ChatLoadMessages.loadEarlierMsgs(chatId string)',
            () => chamar(chatLoad, 'loadEarlierMsgs', chatId),
          ],
          [
            'chat.initialize() e depois loadEarlierMsgs(chat)',
            async () => {
              await chamar(chat, 'initialize');
              await dormir(600);
              return chamar(chatLoad, 'loadEarlierMsgs', chat);
            },
          ],
          [
            'waitForChatLoading() e depois loadEarlierMsgs(chat)',
            async () => {
              await chamar(chat, 'waitForChatLoading');
              return chamar(chatLoad, 'loadEarlierMsgs', chat);
            },
          ],
          ['msgs.initializeFromCache()', () => chamar(col(), 'initializeFromCache')],
          [
            'msgs._query({before,count})',
            () => chamar(col(), '_query', { direction: 'before', count: 50 }),
          ],
          [
            'msgs._serverQuery({before,count})',
            () => chamar(col(), '_serverQuery', { direction: 'before', count: 50 }),
          ],
          [
            'msgs.findQuery({before,count})',
            () => chamar(col(), 'findQuery', { direction: 'before', count: 50 }),
          ],
          ['chat.getAllMsgs()', () => chamar(chat, 'getAllMsgs')],
          [
            'ConversationMsgs.loadEarlierMsgs(chat)',
            () => chamar(conversation, 'loadEarlierMsgs', chat),
          ],
          ['Cmd.openChatBottom(chat)', () => chamar(cmd, 'openChatBottom', chat)],
        ];

        const tentativas: Array<Record<string, unknown>> = [];
        for (const [nome, executar] of candidatas) {
          const antes = quantas();
          let resultado = 'ok';
          try {
            const r = executar();
            if (r === undefined) {
              tentativas.push({ nome, existe: false });
              continue;
            }
            await r;
          } catch (e) {
            resultado = String(e).slice(0, 160);
          }
          // Espera a carga assentar: a promessa resolve antes das mensagens
          // entrarem na coleção.
          for (let i = 0; i < 14 && quantas() === antes; i += 1) await dormir(200);

          tentativas.push({
            nome,
            existe: true,
            antes,
            depois: quantas(),
            ganho: quantas() - antes,
            resultado,
            estadoDaCarga: estado(),
          });
        }

        // --- quantas mensagens este aparelho REALMENTE tem em disco ----------
        //
        // A pergunta que decide tudo: se o multi-device não sincronizou o
        // histórico para cá, nenhuma API de paginação vai inventá-lo.
        // Só contagem e nomes de campo — nada de conteúdo de mensagem.
        interface PedidoGenerico<T> {
          onsuccess: ((e: unknown) => void) | null;
          onerror: (() => void) | null;
          result: T;
        }
        interface LojaIdb {
          keyPath: unknown;
          indexNames: ArrayLike<string>;
          count: (query?: unknown) => PedidoGenerico<number>;
          openCursor: (query?: unknown, dir?: string) => PedidoGenerico<{
            value?: Record<string, unknown>;
            key?: unknown;
          } | null>;
        }
        interface BancoIdb {
          objectStoreNames: ArrayLike<string>;
          close: () => void;
          transaction: (n: string, m: string) => { objectStore: (n: string) => LojaIdb };
        }

        let censo: Record<string, unknown> = {};
        try {
          const idb = (globalThis as { indexedDB?: FabricaIdb }).indexedDB;
          const faixa = (globalThis as { IDBKeyRange?: { bound: (a: unknown, b: unknown) => unknown } })
            .IDBKeyRange;
          if (!idb) throw new Error('sem indexedDB');

          censo = await new Promise<Record<string, unknown>>((resolve) => {
            const pedido = idb.open('model-storage') as unknown as PedidoGenerico<BancoIdb>;
            setTimeout(() => resolve({ erro: 'timeout' }), 10000);
            pedido.onerror = () => resolve({ erro: 'open falhou' });
            pedido.onsuccess = () => {
              const db = pedido.result;
              const nomes = Array.from(db.objectStoreNames) as string[];
              const alvo = nomes.find((n) => /^message$/i.test(n)) ?? nomes.find((n) => /^message/i.test(n));
              if (!alvo) {
                db.close();
                resolve({ erro: 'sem store de mensagem', stores: nomes });
                return;
              }
              try {
                const loja = db.transaction(alvo, 'readonly').objectStore(alvo);
                const total = loja.count();
                total.onsuccess = () => {
                  // Quantas são deste chat? O `_id` das mensagens do WhatsApp é
                  // `<fromMe>_<chatId>_<hash>`, então uma faixa de chave por
                  // prefixo responde sem varrer as 61 mil.
                  const contarPrefixo = (prefixo: string): Promise<number> =>
                    new Promise((r) => {
                      try {
                        const range = faixa?.bound(prefixo, `${prefixo}￿`);
                        const c = loja.count(range);
                        c.onsuccess = () => r(c.result);
                        c.onerror = () => r(-1);
                      } catch {
                        r(-1);
                      }
                    });

                  void (async () => {
                    const recebidas = await contarPrefixo(`false_${chatId}_`);
                    const enviadas = await contarPrefixo(`true_${chatId}_`);

                    // Um registro deste chat: só NOMES de campo, nunca conteúdo.
                    const cursor = loja.openCursor(
                      faixa?.bound(`false_${chatId}_`, `false_${chatId}_￿`),
                    );
                    cursor.onsuccess = (evento) => {
                      const cur = (evento as { target?: { result?: { value?: Record<string, unknown> } } })
                        ?.target?.result ?? cursor.result;
                      const campos = cur?.value ? Object.keys(cur.value) : [];
                      db.close();
                      resolve({
                        store: alvo,
                        keyPath: db ? String(loja.keyPath) : null,
                        indices: Array.from(loja.indexNames) as string[],
                        totalDeMensagens: total.result,
                        desteChat: { recebidas, enviadas },
                        camposDoRegistro: campos,
                      });
                    };
                  })();
                };
              } catch (e) {
                db.close();
                resolve({ erro: String(e).slice(0, 100) });
              }
            };
          });
        } catch (e) {
          censo = { erro: String(e).slice(0, 100) };
        }

        // --- consultas ao banco, que não dependem da interface ---------------
        //
        // Diferente das anteriores: estas não enchem a coleção, elas DEVOLVEM
        // dados. Então o que interessa é o retorno, não o tamanho da coleção.
        const consultas: Array<Record<string, unknown>> = [];
        try {
          const req = (globalThis as { require?: (n: string) => unknown }).require;
          const fetchThread = req?.('WAWebFetchMessagesInThread') as Record<string, unknown> | undefined;
          const visivel = req?.('WAWebDBQueryChatVisibleMessageHelper') as
            | Record<string, unknown>
            | undefined;

          // Os erros anteriores (`reading 'limit'`, `'type'`, `'toString'` de
          // undefined) dizem que a função espera um objeto de parâmetros, não o
          // id solto. Varrendo as formas plausíveis.
          // O erro virou "Invalid key provided. Keys must be of type string,
          // number..." — erro do IndexedDB, não da função. Ela chegou ao banco e
          // recusou o Wid como chave. Falta descobrir em que tipo ela quer o id.
          const wid = chat.id;
          const idTexto = String((wid as { _serialized?: string })?._serialized ?? chatId);
          const rowId = chat.rowId;
          const internalId = chat.internalId;

          const formas: Array<[string, unknown]> = [
            ['{threadId:string,options:{limit}}', { threadId: idTexto, options: { limit: 50 } }],
            ['{chatId:string,options:{limit}}', { chatId: idTexto, options: { limit: 50 } }],
            [
              '{threadId:string,options:{limit,direction}}',
              { threadId: idTexto, options: { limit: 50, direction: 'before' } },
            ],
            ['{threadId:rowId,options:{limit}}', { threadId: rowId, options: { limit: 50 } }],
            [
              '{threadId:internalId,options:{limit}}',
              { threadId: internalId, options: { limit: 50 } },
            ],
            ['{threadId:string,limit}', { threadId: idTexto, limit: 50 }],
          ];

          const testes: Array<[string, () => unknown]> = [];
          for (const [rotulo, forma] of formas) {
            testes.push([
              `queryChatVisibleMessageHelper ${rotulo}`,
              () => chamar(visivel, 'queryChatVisibleMessageHelper', forma),
            ]);
            testes.push([
              `queryMessageForThreadId ${rotulo}`,
              () => chamar(fetchThread, 'queryMessageForThreadId', forma),
            ]);
          }
          testes.push([
            'getLatestMessageInfoForThread {threadId}',
            () => chamar(fetchThread, 'getLatestMessageInfoForThread', { threadId: wid }),
          ]);
          testes.push([
            'getFirstMessageInfoForThread {threadId}',
            () => chamar(fetchThread, 'getFirstMessageInfoForThread', { threadId: wid }),
          ]);

          for (const [nome, executar] of testes) {
            try {
              const bruto = executar();
              if (bruto === undefined) {
                consultas.push({ nome, existe: false });
                continue;
              }
              const res = await bruto;
              // Só forma: quantidade e NOMES de campo. Nunca conteúdo.
              const arr = Array.isArray(res) ? res : null;
              consultas.push({
                nome,
                existe: true,
                tipo: arr ? `array(${arr.length})` : typeof res,
                camposDoPrimeiro:
                  arr && arr[0] && typeof arr[0] === 'object'
                    ? Object.keys(arr[0] as Record<string, unknown>).slice(0, 20)
                    : res && typeof res === 'object'
                      ? Object.keys(res as Record<string, unknown>).slice(0, 20)
                      : null,
              });
            } catch (e) {
              consultas.push({ nome, existe: true, erro: String(e).slice(0, 120) });
            }
          }
        } catch {
          /* sem require */
        }

        // Quem é, afinal, a coleção de mensagens deste chat? O erro
        // `this.findQueryImpl is not a function` sugere que ela não é a classe
        // que implementa consulta ao banco. Se `ChatMsgsCollection` for a
        // classe certa, a consulta existe e não precisa de interface aberta.
        let colecaoInfo: Record<string, unknown> = {};
        try {
          const req = (globalThis as { require?: (n: string) => unknown }).require;
          const mod = req?.('WAWebChatMsgsCollection') as Record<string, unknown> | undefined;
          const Classe = mod?.ChatMsgsCollection as { prototype?: object } | undefined;
          const proto = Classe?.prototype;
          colecaoInfo = {
            classeDaColecaoDoChat: (colecao() as unknown as { constructor?: { name?: string } })
              ?.constructor?.name,
            ehInstanciaDeChatMsgsCollection:
              typeof Classe === 'function' ? colecao() instanceof (Classe as never) : null,
            metodosDaClasse: proto
              ? Object.getOwnPropertyNames(proto)
                  .filter((k) => /query|find|load|fetch/i.test(k))
                  .slice(0, 30)
              : null,
            temFindQueryImplNaInstancia: typeof (colecao() as unknown as Record<string, unknown>)
              ?.findQueryImpl,
          };
        } catch (e) {
          colecaoInfo = { erro: String(e).slice(0, 120) };
        }

        return {
          chatId,
          colecaoInfo,
          identificadoresDoChat: {
            temRowId: typeof chat.rowId,
            temInternalId: typeof chat.internalId,
            camposEscalares: Object.getOwnPropertyNames(chat)
              .filter((k) => {
                try {
                  const v = (chat as Record<string, unknown>)[k];
                  return typeof v === 'number' || typeof v === 'string';
                } catch {
                  return false;
                }
              })
              .slice(0, 30),
          },
          consultasAoBanco: consultas,
          censoDoBancoLocal: censo,
          cobreAJanela: (maisAntiga() ?? Infinity) <= sinceSec,
          mensagensAoFinal: quantas(),
          maisAntigaAoFinal: maisAntiga(),
          estadoDaCarga: estado(),
          inventario,
          tentativas,
        };
      },
      group.id,
      desde,
    )) as unknown;

    process.stdout.write(`\n${JSON.stringify(relatorio, null, 2)}\n\n`);
  } catch (error) {
    log.error('falha na sondagem', error);
  } finally {
    await stopSession(client);
  }
}

main().catch((error) => {
  log.error('falha fatal', error);
  process.exit(1);
});
