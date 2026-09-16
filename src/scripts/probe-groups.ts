/**
 * Diagnóstico: quais grupos o servidor conhece e a memória do WA Web não?
 *
 * Uso:
 *   npm run probe-groups
 *
 * `getAllGroups` lê `Store.Chat`, que nasce do cache local do WA Web e, no
 * aparelho vinculado, é só uma fração da conta. Esperar não muda isso, e o
 * `client.refresh()` do open-wa só reabre a aba sobre o mesmo IndexedDB.
 * Hoje a resposta é `WAWebGroupQueryJob.queryAllGroups()` (ver
 * `enrich/groupDirectory.ts`); este script é o ponto de partida se ela mudar,
 * e mostra a forma dos participantes, que decide se a lista serve.
 *
 * O que resolveria é perguntar ao servidor quais grupos a conta integra — a
 * consulta "participating" que o WhatsApp responde a qualquer dispositivo. O
 * nome da função que faz isso muda de build para build, então este script não
 * adivinha: lista os módulos candidatos, mostra os exports com aridade e chama
 * só os que têm cara de consulta sem argumento, comparando com `Store.Chat`.
 *
 * Só leitura: consulta ao servidor não altera grupo nenhum, e nada é enviado.
 */

import { loadConfig } from '../config';
import { startSession, stopSession } from '../session';
import { createLogger, setLogLevel } from '../util/logger';
import { preparePage } from '../util/page';

const log = createLogger('probe-groups');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  log.info('sessão usada', { sessionId: config.sessionId, dados: config.sessionDataPath });

  const client = await startSession(config);
  try {
    const page = client.getPage();
    if (!page || !(await preparePage(page))) {
      log.error('sem página utilizável');
      return;
    }

    const relatorio = (await page.evaluate(async () => {
      const g = globalThis as {
        Store?: Record<string, unknown>;
        require?: (n: string) => unknown;
      };
      const store = g.Store;
      if (!store) return { erro: 'sem Store' };

      interface Colecao {
        getModelsArray?: () => unknown[];
        models?: unknown[];
      }
      const modelos = (c: unknown): Array<Record<string, unknown>> => {
        const col = c as Colecao | undefined;
        return (col?.getModelsArray?.() ?? col?.models ?? []) as Array<Record<string, unknown>>;
      };
      const idDe = (x: unknown): string => {
        if (typeof x === 'string') return x;
        const o = x as { _serialized?: unknown; id?: unknown } | null;
        if (o && typeof o._serialized === 'string') return o._serialized;
        if (o && o.id !== undefined) return idDe(o.id);
        return '';
      };

      const gruposNoChat = modelos(store.Chat)
        .filter((c) => c.isGroup === true || idDe(c.id).endsWith('@g.us'))
        .map((c) => idDe(c.id));
      const gruposNoMetadata = modelos(store.GroupMetadata).map((m) => idDe(m.id));

      // --- módulos candidatos, só pelo nome -----------------------------------
      let candidatos: string[] = [];
      try {
        const debug = g.require?.('__debug') as { modulesMap?: Record<string, unknown> } | undefined;
        candidatos = Object.keys(debug?.modulesMap ?? {})
          .filter((id) => /group/i.test(id) && /(query|fetch|sync|participat|job)/i.test(id))
          .slice(0, 60);
      } catch (e) {
        candidatos = [`ERRO: ${String(e).slice(0, 80)}`];
      }

      // --- exports com aridade dos candidatos ---------------------------------
      const exportsDe: Record<string, string[]> = {};
      const chamaveis: Array<{ modulo: string; nome: string; fn: () => unknown }> = [];
      for (const id of candidatos) {
        if (id.startsWith('ERRO')) continue;
        try {
          const mod = g.require?.(id) as Record<string, unknown> | undefined;
          if (!mod) continue;
          const lista: string[] = [];
          for (const k of Object.getOwnPropertyNames(mod)) {
            try {
              const v = mod[k];
              if (typeof v !== 'function') continue;
              const aridade = (v as () => void).length;
              lista.push(`${k}/${aridade}`);
              // Só consulta explícita de "todos"/"participando", sem argumento:
              // chamar função desconhecida numa conta real é o que se evita aqui.
              if (
                aridade === 0 &&
                /^(query|fetch)/i.test(k) &&
                /(all|participat)/i.test(k) &&
                /group/i.test(k)
              ) {
                chamaveis.push({ modulo: id, nome: k, fn: () => (v as () => unknown).call(mod) });
              }
            } catch {
              /* getter que lança */
            }
          }
          if (lista.length) exportsDe[id] = lista.slice(0, 40);
        } catch (e) {
          exportsDe[id] = [`ERRO: ${String(e).slice(0, 80)}`];
        }
      }

      // --- consulta ao servidor -----------------------------------------------
      const noChat = new Set(gruposNoChat);
      const consultas: Array<Record<string, unknown>> = [];
      for (const { modulo, nome, fn } of chamaveis) {
        try {
          const res = await Promise.race([
            Promise.resolve(fn()),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20_000)),
          ]);
          const arr = Array.isArray(res)
            ? res
            : res && typeof res === 'object'
              ? (Object.values(res as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? null
              : null;
          const ids = (arr ?? []).map(idDe).filter(Boolean);
          const primeiro = arr?.[0];
          // Forma do participante: decide se a lista do servidor pode substituir
          // a do store (precisa de `@c.us`). Só sufixos e nomes de campo.
          const participantes = (arr ?? []).flatMap((grupo) => {
            const ps = (grupo as { participants?: unknown }).participants;
            return Array.isArray(ps) ? (ps as unknown[]) : [];
          });
          const p0 = participantes[0];
          const sufixos: Record<string, number> = {};
          for (const p of participantes) {
            const r = (p ?? {}) as Record<string, unknown>;
            for (const campo of ['id', 'phoneNumber', 'pn', 'jid', 'lid']) {
              const v = idDe(r[campo]);
              if (!v) continue;
              const chave = `${campo}:${v.slice(v.indexOf('@'))}`;
              sufixos[chave] = (sufixos[chave] ?? 0) + 1;
            }
          }
          consultas.push({
            chamada: `${modulo}.${nome}()`,
            tipo: Array.isArray(res) ? 'array' : typeof res,
            total: arr ? arr.length : null,
            camposDoPrimeiro:
              primeiro && typeof primeiro === 'object'
                ? Object.keys(primeiro as Record<string, unknown>).slice(0, 20)
                : null,
            participantes: {
              total: participantes.length,
              camposDoPrimeiro:
                p0 && typeof p0 === 'object' ? Object.keys(p0 as Record<string, unknown>) : null,
              sufixosPorCampo: sufixos,
            },
            idsForaDoStoreChat: ids.filter((i) => !noChat.has(i)),
            idsDoStoreChatAusentesNaResposta: ids.length
              ? gruposNoChat.filter((i) => !ids.includes(i))
              : null,
          });
        } catch (e) {
          consultas.push({ chamada: `${modulo}.${nome}()`, erro: String(e).slice(0, 160) });
        }
      }

      const stream = store.Stream as Record<string, unknown> | undefined;
      return {
        storeChat: { totalDeChats: modelos(store.Chat).length, grupos: gruposNoChat.length },
        groupMetadata: {
          total: gruposNoMetadata.length,
          foraDoStoreChat: gruposNoMetadata.filter((i) => !noChat.has(i)),
        },
        stream: stream
          ? { mode: String(stream.mode), displayInfo: String(stream.displayInfo) }
          : null,
        modulosCandidatos: candidatos,
        exportsDe,
        consultasAoServidor: consultas,
      };
    })) as unknown;

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
