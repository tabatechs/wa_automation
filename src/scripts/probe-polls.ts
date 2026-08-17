/**
 * Diagnóstico: dá para capturar enquetes nesta sessão?
 *
 * Uso:
 *   npm run probe-polls
 *
 * Por que isto existe em vez de simplesmente escrever o coletor:
 *
 * O `@open-wa/wa-automate` 4.76.0 declara `onPollVote` e `getPollData`, e —
 * ao contrário de `onReaction`, que é marcado `{@license:insiders@}` — nenhum
 * dos dois tem marca de licença. Pela tipagem, deveriam funcionar no plano
 * gratuito. Só que a implementação de verdade não está no bundle: o `wapi.js`
 * empacotado não contém uma única ocorrência de "poll". Ela chega pelo patch
 * remoto (`patch_manager.js`), o que faz a disponibilidade depender de um
 * servidor externo em tempo de execução.
 *
 * Este script responde na prática, com a sessão real, antes de qualquer código
 * de métrica de enquete ser escrito. Só leitura: nunca cria uma enquete.
 */

import { loadConfig } from '../config';
import { startSession, stopSession } from '../session';
import { createLogger, setLogLevel } from '../util/logger';
import { preparePage } from '../util/page';

const log = createLogger('probe-polls');

/** Quanto tempo esperar por um voto ao vivo antes de desistir. */
const LISTEN_MS = 60_000;

interface Findings {
  onPollVoteExiste: boolean;
  onPollVoteRegistrou: boolean;
  getPollDataExiste: boolean;
  enquetesEncontradas: number;
  getPollDataFuncionou: boolean;
  votosVisiveis: number | null;
  /** Quantas pessoas diferentes aparecem votando — o número que decide tudo. */
  votantesDistintos: number;
  /** Votos legíveis direto do store, sem depender do helper do open-wa. */
  storeTemVotos: boolean;
  /** Por que a inspeção do store não pôde ser feita, quando for o caso. */
  motivoDoStore: string | null;
  votoAoVivo: boolean;
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (config.groups.length === 0) {
    log.error('MONITORED_GROUPS está vazio no .env — não há onde procurar enquete');
    process.exit(1);
  }

  const client = await startSession(config);
  const findings: Findings = {
    onPollVoteExiste: false,
    onPollVoteRegistrou: false,
    getPollDataExiste: false,
    enquetesEncontradas: 0,
    getPollDataFuncionou: false,
    votosVisiveis: null,
    votantesDistintos: 0,
    storeTemVotos: false,
    motivoDoStore: null,
    votoAoVivo: false,
  };

  try {
    const api = client as unknown as Record<string, unknown>;
    findings.onPollVoteExiste = typeof api.onPollVote === 'function';
    findings.getPollDataExiste = typeof api.getPollData === 'function';

    // --- 1. o listener aceita registro? ---
    if (findings.onPollVoteExiste) {
      try {
        const registered = await (
          api.onPollVote as (fn: (data: unknown) => void) => Promise<unknown>
        )((data: unknown) => {
          findings.votoAoVivo = true;
          log.info('VOTO CAPTURADO AO VIVO', resumoDoVoto(data));
        });
        // A API devolve `false` quando o listener não pôde ser instalado.
        findings.onPollVoteRegistrou = registered !== false;
      } catch (error) {
        log.warn('onPollVote lançou ao registrar', { error: String(error) });
      }
    }

    // --- 2. existe enquete no histórico recente dos grupos monitorados? ---
    const polls: Array<{ id: string; grupo: string; pergunta: string; em: number }> = [];
    for (const group of config.groups) {
      try {
        // Logo após o boot o histórico do grupo ainda pode não ter
        // sincronizado, e a chamada volta vazia — foi o que fez uma rodada
        // reportar "0 enquetes" com a enquete existindo. Mesma espera com
        // backoff que o roster já usa para a lista de participantes.
        // `getAllMessagesInChat` só devolve o que já está na memória do WA Web
        // — sem paginar antes, isso é a mensagem mais recente e mais nada. É o
        // mesmo motivo pelo qual o BackfillCollector chama
        // loadEarlierMessagesTillDate antes de ler.
        const chatId = group.id as Parameters<typeof client.getAllMessagesInChat>[0];
        const desde = Math.floor((Date.now() - config.backfillDays * 86_400_000) / 1000);
        try {
          await client.loadEarlierMessagesTillDate(
            chatId as Parameters<typeof client.loadEarlierMessagesTillDate>[0],
            desde,
          );
        } catch (error) {
          log.debug('loadEarlierMessagesTillDate falhou; lendo o que houver', {
            error: String(error),
          });
        }

        // Fica com o MAIOR resultado das tentativas, em vez de parar na
        // primeira não-vazia: um grupo com 27 mensagens devolvendo 1 não está
        // pronto, e `> 0` aceitaria esse 1 como se fosse o histórico inteiro.
        let messages: unknown[] = [];
        for (const espera of [0, 1000, 3000]) {
          if (espera) await sleep(espera);
          const lote = ((await client.getAllMessagesInChat(chatId, true, false)) ??
            []) as unknown[];
          if (lote.length > messages.length) messages = lote;
        }
        log.info('histórico lido', {
          grupo: group.id,
          mensagens: messages.length,
        });

        for (const raw of messages ?? []) {
          const message = raw as Record<string, unknown>;
          // O enum `MessageTypes` não tem membro de enquete, então a detecção
          // é pela presença de `pollOptions` — não pelo `type`.
          const options = message.pollOptions;
          if (Array.isArray(options) && options.length > 0) {
            polls.push({
              id: String(message.id ?? ''),
              grupo: group.id,
              pergunta: String(
                (message as { pollName?: unknown; body?: unknown }).pollName ??
                  message.body ??
                  '(sem título)',
              ),
              em: Number(message.t ?? message.timestamp ?? 0),
            });
          }
        }
      } catch (error) {
        log.warn('não foi possível ler o histórico do grupo', {
          grupo: group.id,
          error: String(error),
        });
      }
    }
    findings.enquetesEncontradas = polls.length;

    // --- 3. getPollData responde de verdade? ---
    // Testa da mais recente para a mais antiga, e várias: uma enquete velha
    // sem votos daria um "0 votos visíveis" que não diz nada sobre a nova.
    // O que interessa é o melhor resultado encontrado, não o primeiro.
    const candidatas = [...polls].sort((a, b) => b.em - a.em).slice(0, 5);

    if (findings.getPollDataExiste) {
      for (const alvo of candidatas) {
        log.info('testando getPollData', { enquete: alvo.pergunta, grupo: alvo.grupo });
        try {
          const data = (await (
            api.getPollData as (id: string) => Promise<unknown>
          )(alvo.id)) as Record<string, unknown> | null;

          if (data && typeof data === 'object') {
            findings.getPollDataFuncionou = true;
            const votes = data.votes;
            const quantos = Array.isArray(votes) ? votes.length : 0;
            findings.votosVisiveis = Math.max(findings.votosVisiveis ?? 0, quantos);
            log.info('getPollData respondeu', {
              enquete: alvo.pergunta,
              totalVotes: data.totalVotes,
              opcoes: Array.isArray(data.pollOptions) ? data.pollOptions.length : 0,
              votosVisiveis: quantos,
            });

            // Quem votou importa mais que quantos: se só o próprio número
            // aparece, votos de terceiros continuam ilegíveis e a métrica de
            // enquete não teria como existir.
            if (Array.isArray(votes) && votes.length > 0) {
              const quem = votes
                .map((v) => String((v as { sender?: unknown }).sender ?? '?'))
                .slice(0, 10);
              log.info('votantes visíveis', { quem });
              findings.votantesDistintos = new Set(quem).size;
            }

            if (quantos > 0) break; // achou o que precisava
          }
        } catch (error) {
          log.warn('getPollData lançou', { enquete: alvo.pergunta, error: String(error) });
        }
      }
    }

    // --- 3b. o dado do voto existe na página, mesmo sem o helper? ---
    // Roda SEMPRE, inclusive quando a varredura acima não achou nada: ela já
    // voltou vazia uma vez com a enquete existindo, e condicionar a inspeção
    // ao resultado dela seria herdar o mesmo ponto cego.
    {
      const achados = await inspecionarStore(client, candidatas[0]?.id ?? null);
      findings.storeTemVotos = achados.votos > 0;
      findings.votosVisiveis = Math.max(findings.votosVisiveis ?? 0, achados.votos);
      findings.votantesDistintos = Math.max(findings.votantesDistintos, achados.votantes);
      // O store costuma enxergar o que a API não devolveu.
      findings.enquetesEncontradas = Math.max(
        findings.enquetesEncontradas,
        achados.enquetesNoStore,
      );
      findings.motivoDoStore = achados.motivo;

      if (achados.motivo) log.warn('inspeção do store não pôde ser feita', achados);
      else log.info('inspeção direta do store', achados);
    }

    // --- 4. espera por um voto ao vivo ---
    if (findings.onPollVoteRegistrou) {
      process.stdout.write(
        `\nOuvindo votos por ${LISTEN_MS / 1000}s. ` +
          'Vote numa enquete de um grupo monitorado agora para testar ao vivo.\n',
      );
      await sleep(LISTEN_MS);
    }

    relatorio(findings);
  } finally {
    await stopSession(client);
  }
}

interface AchadosDoStore {
  /** Por que a inspeção não pôde ser feita; null quando correu bem. */
  motivo: string | null;
  /** Quais globais existem na página — decide onde procurar. */
  globais: string[];
  /** Mensagens que o store tem em memória, contra as que a API devolveu. */
  mensagensNoStore: number;
  /** Quantas enquetes o store enxerga, independente da varredura da API. */
  enquetesNoStore: number;
  mensagemEncontrada: boolean;
  pergunta: string | null;
  camposDeEnquete: string[];
  votos: number;
  votantes: number;
  colecaoDeVotos: string | null;
  /** Coleções do store cujo nome sugere voto, para saber onde procurar. */
  colecoesCandidatas: string[];
  /** Forma real de cada campo de enquete — tipo, tamanho e uma amostra. */
  detalheDosCampos: Record<string, string>;
  /** Métodos de Store.PollVote, caso haja como pedir a carga dos votos. */
  metodosDePollVote: string[];
}

/**
 * Vai direto ao store do WhatsApp Web procurar os votos.
 *
 * Existe porque `WAPI.getPollData` chega pelo patch remoto do open-wa e pode
 * estar quebrado sem que isso diga nada sobre o dado em si. Se os votos
 * estiverem na página, o coletor pode lê-los por aqui e dispensar o helper.
 *
 * Toca APIs internas do WA Web, que mudam sem aviso — por isso é diagnóstico,
 * envolto em try/catch, e nunca entra no caminho de captura.
 */
async function inspecionarStore(
  client: Awaited<ReturnType<typeof startSession>>,
  pollId: string | null,
): Promise<AchadosDoStore> {
  const vazio = (motivo: string): AchadosDoStore => ({
    motivo,
    globais: [],
    mensagensNoStore: 0,
    enquetesNoStore: 0,
    mensagemEncontrada: false,
    pergunta: null,
    camposDeEnquete: [],
    votos: 0,
    votantes: 0,
    colecaoDeVotos: null,
    colecoesCandidatas: [],
    detalheDosCampos: {},
    metodosDePollVote: [],
  });

  let page: ReturnType<typeof client.getPage>;
  try {
    page = client.getPage();
    if (!page) return vazio('client.getPage() devolveu vazio');
  } catch (error) {
    return vazio(`client.getPage() lançou: ${String(error)}`);
  }

  // Sem o shim, o evaluate abaixo morre com "__name is not defined".
  if (!(await preparePage(page))) {
    return vazio('não foi possível instalar o shim de __name na página');
  }

  try {
    return await page.evaluate((alvo: string | null) => {
      const janela = globalThis as Record<string, unknown>;
      // Saber o que existe na página é o que separa "não há voto" de "estou
      // procurando no lugar errado".
      const globais = ['Store', 'WAPI', 'require', 'webpackChunkwhatsapp_web_client']
        .filter((nome) => typeof janela[nome] !== 'undefined');

      const store = janela.Store as Record<string, unknown> | undefined;
      if (!store) {
        return {
          motivo: 'window.Store não existe nesta versão do WhatsApp Web',
          globais,
          mensagensNoStore: 0,
          enquetesNoStore: 0,
          mensagemEncontrada: false,
          pergunta: null,
          camposDeEnquete: [] as string[],
          votos: 0,
          votantes: 0,
          colecaoDeVotos: null as string | null,
          colecoesCandidatas: [] as string[],
          detalheDosCampos: {} as Record<string, string>,
          metodosDePollVote: [] as string[],
        };
      }

      const serialize = (v: unknown): string =>
        typeof v === 'string' ? v : String((v as { _serialized?: unknown })?._serialized ?? '');

      const msgs = store.Msg as
        | { get?: (id: string) => unknown; getModelsArray?: () => unknown[] }
        | undefined;
      const modelos = (msgs?.getModelsArray?.() ?? []) as Array<Record<string, unknown>>;

      // O store é procurado por conta própria: `getAllMessagesInChat` já voltou
      // vazio uma vez com a enquete existindo, então depender do id que ele
      // devolve seria repetir o mesmo ponto cego.
      const enquetes = modelos.filter((m) => {
        const opcoes = m.pollOptions;
        return (
          (Array.isArray(opcoes) && opcoes.length > 0) ||
          typeof m.pollName === 'string' ||
          /poll/i.test(String(m.type ?? ''))
        );
      });

      let alvoMsg: Record<string, unknown> | undefined;
      if (alvo) {
        try {
          alvoMsg = msgs?.get?.(alvo) as Record<string, unknown> | undefined;
        } catch {
          /* segue para a varredura */
        }
        if (!alvoMsg) alvoMsg = modelos.find((m) => serialize(m.id) === alvo);
      }
      // Sem alvo (ou não encontrado), usa a enquete mais recente do store.
      if (!alvoMsg && enquetes.length) {
        alvoMsg = enquetes.reduce((maisNova, atual) =>
          Number(atual.t ?? 0) > Number(maisNova.t ?? 0) ? atual : maisNova,
        );
      }

      const camposDeEnquete = alvoMsg
        ? Object.keys(alvoMsg).filter((k) => /poll|vote/i.test(k))
        : [];

      // Onde os votos poderiam estar: no próprio modelo, ou numa coleção
      // dedicada do store.
      let votos = 0;
      let votantes = 0;
      let colecaoDeVotos: string | null = null;

      // Descreve a FORMA de cada campo antes de tentar interpretá-lo: o voto
      // pode estar num objeto, num Map ou num array, e assumir array já fez
      // uma rodada reportar "0 votos" com o campo existindo.
      const detalheDosCampos: Record<string, string> = {};
      const descrever = (v: unknown): string => {
        if (v === null || v === undefined) return String(v);
        if (Array.isArray(v)) return `array(${v.length})`;
        if (v instanceof Map) return `Map(${v.size})`;
        if (v instanceof Set) return `Set(${v.size})`;
        if (typeof v === 'object') {
          const chaves = Object.keys(v as object);
          let amostra = '';
          try {
            amostra = JSON.stringify(v).slice(0, 220);
          } catch {
            amostra = '(não serializável)';
          }
          return `objeto{${chaves.slice(0, 8).join(',')}} ${amostra}`;
        }
        return `${typeof v}: ${String(v).slice(0, 120)}`;
      };

      /** Extrai a lista de votos de qualquer uma dessas formas. */
      const listaDeVotos = (v: unknown): unknown[] => {
        if (Array.isArray(v)) return v;
        if (v instanceof Map) return [...v.values()];
        if (v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          for (const chave of ['pollVotes', 'votes', 'models', '_models', 'items']) {
            const interno = obj[chave];
            if (Array.isArray(interno)) return interno;
            if (interno instanceof Map) return [...interno.values()];
          }
        }
        return [];
      };

      for (const campo of camposDeEnquete) {
        const valor = alvoMsg?.[campo];
        detalheDosCampos[campo] = descrever(valor);
        if (!/vote/i.test(campo)) continue;
        const lista = listaDeVotos(valor);
        if (lista.length > votos) {
          votos = lista.length;
          colecaoDeVotos = `Msg.${campo}`;
          votantes = new Set(
            lista.map((v) => serialize((v as { sender?: unknown })?.sender)),
          ).size;
        }
      }

      // Se a coleção de votos existe mas está vazia, talvez só falte pedir a
      // carga — vale saber o que ela oferece antes de concluir que o dado não
      // chega a este aparelho.
      const pollVote = store.PollVote as Record<string, unknown> | undefined;
      const metodosDePollVote = pollVote
        ? [
            ...Object.keys(pollVote),
            ...Object.getOwnPropertyNames(Object.getPrototypeOf(pollVote) ?? {}),
          ]
            .filter((k) => typeof (pollVote as Record<string, unknown>)[k] === 'function')
            .filter((k) => /load|fetch|find|get|sync|query/i.test(k))
            .slice(0, 15)
        : [];

      const colecoesCandidatas: string[] = [];
      const idDoAlvo = alvoMsg ? serialize(alvoMsg.id) : '';
      // O trecho do meio do id é o serial da mensagem, que é o que costuma
      // aparecer nas chaves de voto.
      const serial = idDoAlvo.split('_')[2] ?? idDoAlvo;

      for (const chave of Object.keys(store)) {
        if (!/poll|vote/i.test(chave)) continue;
        const colecao = store[chave] as { getModelsArray?: () => unknown[] } | undefined;
        const itens = colecao?.getModelsArray?.() ?? [];
        if (!Array.isArray(itens)) continue;
        colecoesCandidatas.push(`${chave}(${itens.length})`);
        if (itens.length === 0 || votos > 0) continue;

        const doAlvo = serial
          ? itens.filter((m) => {
              const v = m as Record<string, unknown>;
              return serialize(v.parentMsgKey ?? v.pollMsgKey ?? v.msgKey).includes(serial);
            })
          : itens;

        if (doAlvo.length) {
          votos = doAlvo.length;
          votantes = new Set(
            doAlvo.map((m) => serialize((m as { sender?: unknown }).sender)),
          ).size;
          colecaoDeVotos = `Store.${chave}`;
        }
      }

      return {
        motivo: null as string | null,
        globais,
        mensagensNoStore: modelos.length,
        enquetesNoStore: enquetes.length,
        mensagemEncontrada: Boolean(alvoMsg),
        pergunta: alvoMsg ? String(alvoMsg.pollName ?? alvoMsg.body ?? '(sem título)') : null,
        camposDeEnquete,
        votos,
        votantes,
        colecaoDeVotos,
        colecoesCandidatas,
        detalheDosCampos,
        metodosDePollVote,
      };
    }, pollId);
  } catch (error) {
    return vazio(`page.evaluate lançou: ${String(error)}`);
  }
}

function resumoDoVoto(data: unknown): Record<string, unknown> {
  const vote = data as Record<string, unknown>;
  return {
    de: vote.sender ?? vote.senderObj,
    opcoes: vote.selectedOptionValues ?? vote.selectedOptionLocalIds,
    enquete: vote.parentMsgKey,
  };
}

function relatorio(f: Findings): void {
  const linhas: string[] = ['', '─'.repeat(64), 'Enquetes — resultado do diagnóstico', '─'.repeat(64)];
  const marca = (v: boolean) => (v ? '✅' : '❌');

  linhas.push(`${marca(f.onPollVoteExiste)}  client.onPollVote existe na API`);
  linhas.push(`${marca(f.onPollVoteRegistrou)}  onPollVote aceitou o registro do listener`);
  linhas.push(`${marca(f.getPollDataExiste)}  client.getPollData existe na API`);
  linhas.push(`ℹ️   enquetes encontradas no histórico: ${f.enquetesEncontradas}`);
  linhas.push(`${marca(f.getPollDataFuncionou)}  getPollData respondeu com dados`);
  linhas.push(
    f.motivoDoStore
      ? `⚠️   inspeção do store não pôde ser feita: ${f.motivoDoStore}`
      : `${marca(f.storeTemVotos)}  votos legíveis direto do store (sem o helper)`,
  );
  if (f.votosVisiveis !== null) {
    linhas.push(`ℹ️   votos visíveis: ${f.votosVisiveis} (de ${f.votantesDistintos} pessoa(s))`);
  }
  linhas.push(`${marca(f.votoAoVivo)}  voto capturado ao vivo durante a escuta`);
  linhas.push('');

  // Pouco importa por qual caminho o voto apareceu — helper ou store. O que
  // decide é se ele apareceu.
  const capturaVotos = (f.votosVisiveis ?? 0) > 0;
  const via = f.getPollDataFuncionou
    ? 'getPollData'
    : f.storeTemVotos
      ? 'o store do WhatsApp Web (o helper do open-wa está quebrado)'
      : 'o listener ao vivo';

  if (f.votantesDistintos >= 2 || (capturaVotos && f.votoAoVivo)) {
    linhas.push('VEREDITO: enquetes são capturáveis nesta sessão.');
    linhas.push(`Votos de mais de uma pessoa são legíveis via ${via} —`);
    linhas.push('pollResponseRate e pollVotesCast terão dado real.');
  } else if (capturaVotos || f.votoAoVivo) {
    linhas.push(`(o caminho que funcionou foi ${via})`);
    linhas.push('VEREDITO: parcial — a API lê votos, mas só de uma pessoa até agora.');
    linhas.push('Se esse voto foi o SEU, ainda não está provado que votos de terceiros');
    linhas.push('são legíveis, e é isso que a métrica precisa. Peça para outra pessoa');
    linhas.push('votar na mesma enquete e rode de novo.');
  } else if (f.enquetesEncontradas === 0) {
    linhas.push('VEREDITO: inconclusivo — não há enquete no histórico dos grupos monitorados.');
    linhas.push('Crie uma enquete num grupo monitorado, peça votos e rode de novo.');
  } else if (f.getPollDataFuncionou && f.votosVisiveis === 0) {
    linhas.push('VEREDITO: a API responde, mas nenhum voto é visível.');
    linhas.push('Votos de enquete são criptografados ponta a ponta; é possível que');
    linhas.push('esta conta não consiga lê-los. Confirme que alguém realmente votou');
    linhas.push('na enquete testada — se continuar zero, as métricas de enquete ficam nulas.');
  } else if (f.storeTemVotos) {
    linhas.push('VEREDITO: o helper do open-wa está quebrado, mas o dado existe.');
    linhas.push('Os votos são legíveis direto do store — dá para construir o coletor');
    linhas.push('por esse caminho, como já é feito com a ponte LID→telefone.');
  } else {
    linhas.push('VEREDITO: enquetes NÃO são capturáveis nesta sessão.');
    linhas.push('Nem o helper do open-wa (que vem de um patch remoto) nem o store');
    linhas.push('entregam os votos. pollVotesCast e pollResponseRate ficam nulos —');
    linhas.push('o resto das métricas não é afetado.');
  }

  linhas.push('─'.repeat(64), '');
  process.stdout.write(linhas.join('\n'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error('falha no diagnóstico', error);
    process.exit(1);
  });
