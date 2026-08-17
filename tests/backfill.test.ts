/*
 * Backfill: janela, deduplicação e a promessa de não chamar carregamento.
 *
 * O backfill lê só o que o WA Web já tem em memória. As funções de histórico
 * do open-wa estão quebradas nesta build (ver CLAUDE.md), então o cliente falso
 * daqui explode se alguma delas for chamada: é o teste que impede a reserva
 * quebrada de voltar por descuido.
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

const G = '120363000000000000@g.us';
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
}

function makeHarness(stateDir: string, store: unknown[], opts: { maxMessages?: number } = {}) {
  const emitted: string[] = [];
  // Cópia própria por harness: a fixture é compartilhada entre os blocos e não
  // pode ser reordenada por um deles.
  const own = store.slice();
  const proibida = (nome: string) => async () => {
    throw new Error(`o backfill não pode chamar ${nome}: está quebrada nesta build do WA Web`);
  };

  const ctx = {
    client: {
      getAllMessagesInChat: async () => own.slice(),
      loadEarlierMessagesTillDate: proibida('loadEarlierMessagesTillDate'),
      loadEarlierMessages: proibida('loadEarlierMessages'),
    },
    config: {
      groups: [{ id: G }],
      backfillEnabled: true,
      backfillDays: 7,
      backfillMaxMessages: opts.maxMessages ?? 5000,
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
    groupName: async () => 'Grupo de exemplo',
    emit: async (e: { type: string; payload: { messageId?: string } }) => {
      if (e.type === 'message') emitted.push(e.payload.messageId ?? '?');
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;

  return { ctx, emitted } as Harness;
}

async function run() {
  // Trecho de 7 dias terminando numa notificação de sistema sem timestamp:
  // ela não é mensagem e não pode virar evento nem derrubar nenhuma conta.
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
    ok('emite o que está em memória, sem chamar carregamento de histórico');

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

  // ---- fora da janela e teto de mensagens ----
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    const antiga = msg('m0', 30 * DAY);
    const h = makeHarness(dir, [antiga, ...historico]);
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h.ctx);

    assert.ok(!h.emitted.includes('m0'), 'o que é anterior à janela não vira evento');
    ok('mensagem fora da janela de BACKFILL_DAYS não é emitida');

    const dir2 = mkdtempSync(path.join(tmpdir(), 'wa-bf-'));
    const h2 = makeHarness(dir2, historico, { maxMessages: 2 });
    await new BackfillCollector(new MessageWindow(2000, 7 * DAY)).start(h2.ctx);

    // O teto corta pelas mais antigas: o recente é o que ainda rende reação e
    // leitura, e é o que o monitor tem chance de completar ao vivo.
    assert.deepStrictEqual(
      h2.emitted.sort(),
      ['m4', 'm5'],
      `o teto precisa manter as mais recentes; veio ${JSON.stringify(h2.emitted)}`,
    );
    ok('teto de mensagens mantém as mais recentes');

    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }

  console.log('\nSmoke test — backfill\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`);
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
