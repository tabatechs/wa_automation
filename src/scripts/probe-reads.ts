/**
 * Diagnóstico: dá para saber quem leu as mensagens que EU enviei?
 *
 * Uso:
 *   npm run probe-reads
 *
 * Por que isto existe, como o `probe-polls`: a v4.76 declara `getMessageInfo`
 * (marcada `{@license:insiders@}`) e `getMessageReaders` (sem marca), mas
 * nenhuma das duas está no `wapi.js` empacotado — as duas chegam pelo patch
 * remoto. Prometer a funcionalidade com base na tipagem seria repetir o erro
 * das enquetes.
 *
 * A diferença em relação às enquetes é o que dá esperança aqui: voto de enquete
 * é cifrado ponta a ponta e só o aparelho principal decifra, enquanto
 * confirmação de leitura é um recibo que o servidor entrega a quem enviou — e a
 * todos os dispositivos conectados. Este script confirma na prática.
 *
 * Só leitura: não envia mensagem nenhuma. Ele procura, no histórico recente dos
 * grupos monitorados, mensagens que a própria conta já enviou.
 */

import type { Message } from '@open-wa/wa-automate';
import { loadConfig } from '../config';
import { startSession, stopSession } from '../session';
import { MessageInfoReader } from '../enrich/messageInfo';
import { createLogger, setLogLevel } from '../util/logger';
import { normalizeParticipant } from '../collectors/readReceipts';

const log = createLogger('probe-reads');

/** Quantas mensagens próprias inspecionar, das mais recentes para trás. */
const MAX_MENSAGENS = 5;

interface Findings {
  mensagensPropriasEncontradas: number;
  getMessageInfoExiste: boolean;
  getMessageReadersExiste: boolean;
  /** Rota que devolveu resultado, se alguma. */
  rotaQueFuncionou: string | null;
  /** O número que decide tudo: quantas pessoas distintas apareceram como leitoras. */
  leitoresDistintos: number;
  /** Quantas das mensagens inspecionadas tiveram ao menos um leitor. */
  mensagensComLeitura: number;
  /** Horário de leitura veio junto? Sem ele o dado ainda serve, mas perde o "quando". */
  temHorario: boolean;
  detalhes: string[];
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (config.groups.length === 0) {
    log.error('nenhum grupo habilitado em config/groups.json — não há onde procurar');
    process.exit(1);
  }

  const client = await startSession(config);
  const findings: Findings = {
    mensagensPropriasEncontradas: 0,
    getMessageInfoExiste: false,
    getMessageReadersExiste: false,
    rotaQueFuncionou: null,
    leitoresDistintos: 0,
    mensagensComLeitura: 0,
    temHorario: false,
    detalhes: [],
  };

  try {
    const api = client as unknown as Record<string, unknown>;
    findings.getMessageInfoExiste = typeof api.getMessageInfo === 'function';
    findings.getMessageReadersExiste = typeof api.getMessageReaders === 'function';

    const reader = new MessageInfoReader(client);
    const leitores = new Set<string>();

    // Carrega alguns dias de histórico — mais do que a janela do coletor, para
    // que o relatório consiga dizer "achei, mas está fora da janela".
    const desdeMs = Date.now() - config.backfillDays * 24 * 3600e3;

    for (const group of config.groups) {
      const nome = group.label ?? group.id;
      const { proprias, totalNoStore } = await mensagensProprias(client, group.id, desdeMs);
      findings.mensagensPropriasEncontradas += proprias.length;

      if (proprias.length === 0) {
        findings.detalhes.push(
          `${nome}: nenhuma mensagem própria (${totalNoStore} mensagens no store)`,
        );
        continue;
      }
      findings.detalhes.push(
        `${nome}: ${proprias.length} mensagem(ns) própria(s) de ${totalNoStore} no store`,
      );

      for (const message of proprias.slice(0, MAX_MENSAGENS)) {
        const messageId = String(message.id ?? '');
        const horas = idadeHoras(message);
        const idade = horas === null ? 'idade?' : `${horas.toFixed(1)}h`;

        const info = await reader.read(messageId);
        if (!info) {
          findings.detalhes.push(`  [${idade}] nenhuma rota respondeu`);
          continue;
        }

        findings.rotaQueFuncionou = info.source;
        if (info.readers.length > 0) findings.mensagensComLeitura += 1;
        for (const receipt of info.readers) {
          leitores.add(normalizeParticipant(receipt.contactId));
          if (receipt.readAt) findings.temHorario = true;
        }

        findings.detalhes.push(
          `  [${idade}] ${info.readers.length} leitor(es) via ${info.source}` +
            (info.readRemaining !== null ? `, faltam ${info.readRemaining}` : ''),
        );
      }
    }

    findings.leitoresDistintos = leitores.size;
  } catch (error) {
    log.error('falha durante a sondagem', error);
  } finally {
    relatorio(findings);
    await stopSession(client);
  }
}

/**
 * Mensagens da própria conta no grupo, mais recentes primeiro.
 *
 * O `loadEarlierMessagesTillDate` antes do `getAllMessagesInChat` NÃO é
 * opcional: sozinha, essa chamada devolve só o que já está na memória do WA
 * Web — tipicamente uma ou duas mensagens num grupo com centenas. Foi o que
 * fez a primeira versão deste probe relatar "nenhuma mensagem própria" num
 * histórico que tinha várias. Mesma armadilha documentada no CLAUDE.md.
 */
async function mensagensProprias(
  client: Awaited<ReturnType<typeof startSession>>,
  groupId: string,
  desdeMs: number,
): Promise<{ proprias: Message[]; totalNoStore: number }> {
  const chatId = groupId as Parameters<typeof client.getAllMessagesInChat>[0];

  // Aquecimento antes de pedir histórico. `loadEarlierMsgs` do WA Web falha com
  // "Cannot read properties of undefined (reading 'waitForChatLoading')" quando
  // o chat ainda não foi hidratado — e logo após o boot ele não foi. O monitor
  // não sofre disso porque o snapshot de grupo já tocou cada chat antes do
  // backfill; este script ia direto, e relatava store vazio como se fosse
  // ausência de mensagens.
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    try {
      await client.getChatById(chatId as Parameters<typeof client.getChatById>[0]);
    } catch {
      /* o que importa é ter tocado o chat */
    }
    await sleep(2000);

    try {
      await client.loadEarlierMessagesTillDate(
        chatId as Parameters<typeof client.loadEarlierMessagesTillDate>[0],
        Math.floor(desdeMs / 1000), // a lib espera SEGUNDOS
      );
      break;
    } catch (error) {
      log.warn('loadEarlierMessagesTillDate falhou', {
        groupId,
        tentativa,
        error: String(error),
      });
      if (tentativa === 3) {
        // Reserva: algumas voltas de paginação cobrem os últimos dias.
        for (let i = 0; i < 10; i += 1) {
          try {
            await client.loadEarlierMessages(
              chatId as Parameters<typeof client.loadEarlierMessages>[0],
            );
          } catch (erroPaginacao) {
            log.warn('paginação manual também falhou', { error: String(erroPaginacao) });
            break;
          }
        }
      }
    }
  }

  try {
    const all = (await client.getAllMessagesInChat(chatId, true, false)) ?? [];
    return {
      totalNoStore: all.length,
      proprias: all
        .filter((m) => Boolean(m?.fromMe))
        .sort((a, b) => Number(b?.timestamp ?? 0) - Number(a?.timestamp ?? 0)),
    };
  } catch (error) {
    log.warn('getAllMessagesInChat falhou', { groupId, error: String(error) });
    return { proprias: [], totalNoStore: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Idade da mensagem em horas, para dizer se ela ainda cabe na janela. */
function idadeHoras(message: Message): number | null {
  const raw = Number(message?.timestamp ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e11 ? raw : raw * 1000;
  return (Date.now() - ms) / 3_600_000;
}

function relatorio(f: Findings): void {
  const linhas: string[] = [
    '',
    '='.repeat(72),
    'CONFIRMAÇÃO DE LEITURA — RESULTADO',
    '='.repeat(72),
    `mensagens próprias encontradas .... ${f.mensagensPropriasEncontradas}`,
    `getMessageInfo declarado ......... ${f.getMessageInfoExiste ? 'sim' : 'não'}`,
    `getMessageReaders declarado ...... ${f.getMessageReadersExiste ? 'sim' : 'não'}`,
    `rota que funcionou ............... ${f.rotaQueFuncionou ?? 'NENHUMA'}`,
    `mensagens com ao menos 1 leitura . ${f.mensagensComLeitura}`,
    `leitores distintos ............... ${f.leitoresDistintos}`,
    `horário da leitura disponível .... ${f.temHorario ? 'sim' : 'não'}`,
    '',
  ];

  if (f.mensagensPropriasEncontradas === 0) {
    linhas.push(
      'INCONCLUSIVO: não há mensagem sua nos últimos dias de histórico.',
      'Se o número de mensagens no store (abaixo) estiver muito baixo, o problema',
      'é o carregamento do histórico, não a ausência de mensagens suas.',
      'Mande uma mensagem pelo celular num grupo monitorado, espere alguém abrir',
      'e rode de novo. O monitor não envia nada por você — de propósito.',
    );
  } else if (!f.rotaQueFuncionou) {
    linhas.push(
      'NEGATIVO: nenhuma via devolveu dados de leitura nesta sessão.',
      'O coletor se desliga sozinho nesse caso; nada mais a fazer.',
    );
  } else if (f.leitoresDistintos === 0) {
    linhas.push(
      'PARCIAL: a rota respondeu, mas ninguém aparece como leitor.',
      'Pode ser real (mensagem recente que ninguém abriu) ou a lista pode vir',
      'sempre vazia nesta sessão. Repita com uma mensagem que você SABE que foi',
      'lida — o visto duplo azul no celular é a referência.',
    );
  } else {
    linhas.push(
      'POSITIVO: dá para saber quem abriu suas mensagens.',
      'O ReadReceiptsCollector já faz isso a cada ciclo e grava `message_read`.',
    );
  }

  if (f.detalhes.length) {
    linhas.push('', '-- por mensagem ' + '-'.repeat(56));
    for (const detalhe of f.detalhes) linhas.push(`  ${detalhe}`);
  }
  linhas.push('='.repeat(72), '');

  process.stdout.write(linhas.join('\n'));
}

main().catch((error) => {
  log.error('falha fatal', error);
  process.exit(1);
});
