/*
 * Reproduz o bug de reação duplicada e prova a correção.
 *
 * Cenário real: run 1 captura a reação ao vivo → processo reinicia (a
 * MessageWindow, que é só memória, nasce vazia) → backfill retraz a mensagem →
 * a reação NÃO pode ser emitida de novo.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReactionsCollector } from '../src/collectors/reactions';
import { MessageWindow } from '../src/collectors/messageWindow';
import type { CollectorContext } from '../src/collectors/Collector';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

const G = '120363000000000001@g.us';
const MSG = 'true_..._3EB0F3CBF03C9CAAD72154_199372465811459@lid';
const NOW = Date.now();
const SENDER = '237194031669378@lid';

/** Uma mensagem com o conjunto de reações informado. */
const msg = (reactions: Array<[string, string]>) => ({
  id: MSG,
  timestamp: Math.floor((NOW - 60_000) / 1000),
  reactions: [
    {
      senders: reactions.map(([sender, emoji]) => ({
        senderUserJid: sender,
        reactionText: emoji,
        timestamp: Math.floor(NOW / 1000),
      })),
    },
  ],
});

function makeCtx(stateDir: string, emitted: string[], messages: unknown[]): CollectorContext {
  return {
    client: {
      getAllMessagesInChat: async () => messages,
    },
    config: {
      groups: [{ id: G }],
      reactionPollMs: 30_000,
      reactionWindowMs: 48 * 3600e3,
      backfillDays: 7,
      stateDir,
    },
    roster: { resolve: async (id: string) => ({ id, phone: null, name: null, nameSource: null }) },
    sink: { write: async () => {} },
    checkpoint: {} as never,
    isMonitored: (id: unknown): id is string => id === G,
    groupName: async () => 'Tabatech',
    emit: async (e: { type: string; payload: { emoji: string } }) => {
      emitted.push(`${e.type}:${e.payload.emoji}`);
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;
}

async function run() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-react-'));

  // ---------- RUN 1: mensagem chega ao vivo, depois alguém reage ----------
  {
    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir);

    // A mensagem chega ao vivo, ainda sem reações.
    window.track(G, MSG, NOW - 60_000);

    const ctx = makeCtx(dir, emitted, [msg([[SENDER, '❤️']])]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(emitted, ['reaction_added:❤️'], 'run 1 deve emitir a reação uma vez');
    ok('run 1: reação em mensagem vista ao vivo é capturada');
  }

  // ---------- RUN 2: restart em que só OUTRA mensagem entra na janela ----------
  // Este é o passo que disparava o bug: a poda antiga apagava do estado tudo
  // que não estivesse na janela, e a janela nasce vazia a cada restart.
  {
    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir);

    // Chega uma mensagem nova; a antiga (MSG) não está na janela.
    const OUTRA = 'true_..._OUTRA_MENSAGEM@lid';
    window.track(G, OUTRA, NOW - 30_000);

    const ctx = makeCtx(dir, emitted, [
      { id: OUTRA, timestamp: Math.floor((NOW - 30_000) / 1000), reactions: [] },
    ]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(emitted, [], 'nada a emitir aqui');
    ok('run 2: restart em que só outra mensagem ocupa a janela');
  }

  // ---------- RUN 3: backfill retraz a mensagem antiga ----------
  {
    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir);

    // O backfill retraz a mensagem original, que já carrega a ❤️.
    window.track(G, MSG, NOW - 60_000);

    const ctx = makeCtx(dir, emitted, [msg([[SENDER, '❤️']])]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(
      emitted,
      [],
      `a ❤️ NÃO pode ser reemitida; emitiu: ${JSON.stringify(emitted)}`,
    );
    ok('run 3: backfill retrazendo a mensagem NÃO reemite a reação já registrada');
  }

  // ---------- RUN 4: reação nova depois do restart ainda é capturada ----------
  {
    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir);
    window.track(G, MSG, NOW - 60_000);

    const ctx = makeCtx(dir, emitted, [
      msg([
        [SENDER, '❤️'],
        ['999@lid', '👍'],
      ]),
    ]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(emitted, ['reaction_added:👍'], 'só a reação inédita deve sair');
    ok('run 4: reação nova é capturada, a já conhecida permanece silenciosa');
  }

  // ---------- RUN 5: remoção de reação ----------
  {
    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir);
    window.track(G, MSG, NOW - 60_000);

    const ctx = makeCtx(dir, emitted, [msg([[SENDER, '❤️']])]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(emitted, ['reaction_removed:👍'], 'a 👍 sumiu → remoção');
    ok('run 5: retirada de reação vira reaction_removed');
  }

  // ---------- migração do estado v1 ----------
  {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'wa-react-v1-'));
    writeFileSync(
      path.join(dir2, 'reactions.json'),
      JSON.stringify({ version: 1, groups: { [G]: { [MSG]: [`${SENDER}|❤️`] } } }),
    );

    const emitted: string[] = [];
    let collector: ReactionsCollector | null = null;
    const window = new MessageWindow(200, 48 * 3600e3, (g, m, at) =>
      collector?.noteLiveMessage(g, m, at),
    );
    collector = new ReactionsCollector(window, dir2);
    window.track(G, MSG, NOW - 60_000);

    const ctx = makeCtx(dir2, emitted, [msg([[SENDER, '❤️']])]);
    await collector.start(ctx);
    await collector.stop();

    assert.deepStrictEqual(emitted, [], 'estado v1 tem de continuar valendo após a migração');
    const saved = JSON.parse(readFileSync(path.join(dir2, 'reactions.json'), 'utf8'));
    assert.strictEqual(saved.version, 2, 'e ser regravado no formato v2');
    ok('estado v1 existente migra para v2 sem reemitir nada');
    rmSync(dir2, { recursive: true, force: true });
  }

  rmSync(dir, { recursive: true, force: true });
  console.log('\nSmoke test — reações\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`);
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
