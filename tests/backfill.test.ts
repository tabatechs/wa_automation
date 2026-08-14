/*
 * Backfill: paginação, cobertura da janela e deduplicação.
 *
 * O bug que motivou estes testes: uma notificação de sistema sem timestamp
 * utilizável fazia o cálculo do "mais antigo" cair para 0, a paginação concluir
 * que já tinha alcançado o passado e encerrar na primeira volta — resultado, 2
 * mensagens capturadas num grupo de 830 pessoas em 7 dias.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BackfillCollector } from '../src/collectors/backfill';
import { MessageWindow } from '../src/collectors/messageWindow';
import { CheckpointStore } from '../src/state/checkpoint';
import type { CollectorContext } from '../src/collectors/Collector';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

const G = '120363428946452522@g.us';
const DAY = 24 * 3600e3;
const NOW = Date.now();

const msg = (id: string, agoMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  timestamp: Math.floor((NOW - agoMs) / 1000),
  type: 'chat',
  body: `msg ${id}`,
  from: '5511999999999@c.us',
  ...extra,
});

/** Notificação de sistema: sem timestamp utilizável. Era o gatilho do bug. */
const semTimestamp = (id: string) => ({ id, timestamp: 0, type: 'gp2', body: '' });

interface Harness {
  ctx: CollectorContext;
  emitted: string[];
  loadTillDateCalls: number[];
  paginacoes: () => number;
}

function makeHarness(stateDir: string, store: unknown[], opts: { failTillDate?: boolean } = {}) {
  const emitted: string[] = [];
  const loadTillDateCalls: number[] = [];
  // Cópia própria por harness: a fixture é compartilhada entre os blocos e não
  // pode ser reordenada por um deles.
  const own = store.slice();
  let paginacoes = 0;
  // Simula o servidor: loadEarlierMessagesTillDate revela o histórico completo.
  let visible = own.slice(-2);

  const ctx = {
    client: {
      getAllMessagesInChat: async () => visible,
      loadEarlierMessagesTillDate: async (_id: string, ts: number) => {
        if (opts.failTillDate) throw new Error('indisponível');
        loadTillDateCalls.push(ts);
        visible = own.slice();
        return visible;
      },
      loadEarlierMessages: async () => {
        // Reserva: revela de 2 em 2, como uma paginação real.
        paginacoes += 1;
        visible = own.slice(Math.max(0, own.length - visible.length - 2));
        return visible;
      },
    },
    config: {
      groups: [{ id: G }],
      backfillEnabled: true,
      backfillDays: 7,
      backfillMaxMessages: 5000,
      reactionWindowMs: 7 * DAY,
    },
    roster: {
      resolve: async (id: string) => ({ id, phone: null, name: null, nameSource: null }),
      resolveSelf: async () => null,
      resolveMany: async () => [],
      groupMembers: async () => [],
    },
    checkpoint: new CheckpointStore(stateDir),
    isMonitored: (id: unknown): id is string => id === G,
    groupName: async () => 'RADAR TABATA #04',
    emit: async (e: { type: string; payload: { messageId?: string } }) => {
      if (e.type === 'message') emitted.push(e.payload.messageId ?? '?');
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;

  return { ctx, emitted, loadTillDateCalls, paginacoes: () => paginacoes } as Harness;
}

async function run() {
  // Histórico de 7 dias terminando numa notificação de sistema sem timestamp.
  // A posição importa: por ser a entrada mais recente, ela cai na primeira
  // fatia que o store devolve — e era exatamente aí que o cálculo antigo do
  // "mais antigo" via 0, concluía ter alcançado o passado e abortava a
  // paginação antes de carregar qualquer coisa.
  const historico = [
    msg('m1', 6 * DAY),
    msg('m2', 5 * DAY),
    msg('m3', 3 * DAY),
    msg('m4', 1 * DAY),
    msg('m5', 2 * 3600e3),
    semTimestamp('gp2-a'),
  ];

  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    const h = makeHarness(dir, historico);
    const window = new MessageWindow(2000, 7 * DAY);
    await new BackfillCollector(window).start(h.ctx);

    assert.deepStrictEqual(
      h.emitted.sort(),
      ['m1', 'm2', 'm3', 'm4', 'm5'],
      `esperava as 5 mensagens da janela; veio ${JSON.stringify(h.emitted)}`,
    );
    ok('recupera a janela inteira mesmo com notificação sem timestamp no meio');

    assert.strictEqual(h.loadTillDateCalls.length, 1, 'usa loadEarlierMessagesTillDate');
    const pedido = h.loadTillDateCalls[0]!;
    const esperado = Math.floor((NOW - 7 * DAY) / 1000);
    assert.ok(Math.abs(pedido - esperado) < 5, 'pede a data em SEGUNDOS');
    ok('pede o histórico até a data certa, em segundos');

    assert.strictEqual(window.size(G), 5, 'mensagens entram na janela de reações');
    ok('mensagens recuperadas passam a ser vigiadas para reações');
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- rodar de novo não duplica ----
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    const h1 = makeHarness(dir, historico);
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h1.ctx);
    assert.strictEqual(h1.emitted.length, 5);

    const h2 = makeHarness(dir, historico);
    // A janela precisa acompanhar o restart: mensagem já emitida não vira
    // evento de novo, mas volta a ser observada.
    const janela2 = new MessageWindow(2000, 7 * DAY);
    await new BackfillCollector(janela2).start(h2.ctx);
    assert.deepStrictEqual(h2.emitted, [], `segunda passada não pode emitir nada`);
    ok('segunda execução não duplica nada (dedupe por messageId)');

    assert.strictEqual(
      janela2.size(G),
      5,
      'sem isto, reações e leituras de mensagens já conhecidas deixam de ser observadas a cada restart',
    );
    ok('mensagem já emitida continua vigiada depois do restart');

    // E a marca `fromMe` chega junto: é ela que decide o que o coletor de
    // confirmações de leitura vigia, e só mensagem própria tem leitura.
    const proprias: string[] = [];
    const janela3 = new MessageWindow(2000, 7 * DAY, (_g, id, _at, fromMe) => {
      if (fromMe) proprias.push(id);
    });
    const h4 = makeHarness(dir, [...historico, msg('m7', 30_000, { fromMe: true })]);
    await new BackfillCollector(janela3).start(h4.ctx);
    assert.deepStrictEqual(proprias, ['m7'], 'só a mensagem própria entra como fromMe');
    ok('backfill marca a mensagem própria para a vigilância de leitura');

    // Mensagem nova aparece depois: só ela sai.
    const h3 = makeHarness(dir, [...historico, msg('m6', 60_000)]);
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h3.ctx);
    assert.deepStrictEqual(h3.emitted, ['m6'], 'só a mensagem inédita');
    ok('retomada emite apenas o que chegou desde a última execução');
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- checkpoint adiantado não pode esconder histórico ----
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    // Simula o estado real: uma execução anterior registrou só a mensagem mais
    // recente, deixando o checkpoint à frente de todo o histórico anterior.
    const ck = new CheckpointStore(dir);
    ck.markMessageEmitted(G, 'm5', NOW - 2 * 3600e3);
    ck.save();

    const h = makeHarness(dir, historico);
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h.ctx);

    assert.deepStrictEqual(
      h.emitted.sort(),
      ['m1', 'm2', 'm3', 'm4'],
      'o histórico anterior ao checkpoint precisa ser alcançável',
    );
    ok('checkpoint adiantado não torna o histórico inalcançável');
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- reserva quando loadEarlierMessagesTillDate falha ----
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    const h = makeHarness(dir, historico, { failTillDate: true });
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h.ctx);

    // Estrito de propósito: com o cálculo antigo, a notificação sem timestamp
    // na primeira fatia abortava a paginação e só 1 mensagem era emitida.
    assert.ok(h.paginacoes() > 0, 'a reserva precisa efetivamente paginar, não desistir na 1a volta');
    assert.deepStrictEqual(
      h.emitted.sort(),
      ['m1', 'm2', 'm3', 'm4', 'm5'],
      `a paginação manual precisa cobrir a janela inteira; veio ${JSON.stringify(h.emitted)}`,
    );
    ok('reserva manual pagina a janela inteira mesmo com notificação sem timestamp na 1a fatia');
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nSmoke test — backfill\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`);
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
