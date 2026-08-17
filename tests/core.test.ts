/* Smoke test das partes puras: config, sink, janela e diff de reações. */
import assert from 'node:assert';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JsonlSink } from '../src/sink/JsonlSink';
import { MessageWindow } from '../src/collectors/messageWindow';
import { chatIdToE164, waTimestampToIso, isGroupId } from '../src/util/phone';
import { localIso, localStamp, dateKey } from '../src/util/time';
import { EVENT_SCHEMA_VERSION, type CapturedEvent } from '../src/types';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

// --- phone utils ---
assert.strictEqual(chatIdToE164('5511999998888@c.us'), '+5511999998888');
assert.strictEqual(chatIdToE164('120363000000000000@g.us'), null, 'grupo não tem número');
assert.strictEqual(chatIdToE164('123456789@lid'), null, 'lid não tem número');
assert.strictEqual(chatIdToE164(null), null);
ok('chatIdToE164 só devolve número para @c.us válido');

// 18:13:20 em UTC é 15:13:20 em São Paulo — o mesmo instante, escrito no fuso
// de quem lê os dados.
assert.strictEqual(waTimestampToIso(1754936000), '2025-08-11T15:13:20.000-03:00');
assert.strictEqual(waTimestampToIso(1754936000000), '2025-08-11T15:13:20.000-03:00');
assert.strictEqual(waTimestampToIso(0), null);
ok('waTimestampToIso aceita segundos e milissegundos, no fuso de São Paulo');

// --- carimbos locais ---
// O deslocamento faz parte do formato: quem consome esses campos usa
// `new Date(...)` e precisa cair no mesmo instante de sempre.
const instante = new Date('2026-08-17T21:05:16.159Z');
assert.strictEqual(localIso(instante), '2026-08-17T18:05:16.159-03:00');
assert.strictEqual(new Date(localIso(instante)).getTime(), instante.getTime(), 'mesmo instante');
assert.strictEqual(localStamp(instante), '2026-08-17T18-05-16');
// Meia-noite em São Paulo é 03:00Z: o dia da série tem de virar aqui, não lá.
assert.strictEqual(dateKey(new Date('2026-08-18T02:59:59Z')), '2026-08-17');
assert.strictEqual(dateKey(new Date('2026-08-18T03:00:00Z')), '2026-08-18');
ok('localIso preserva o instante e o dia vira à meia-noite de São Paulo');

assert.ok(isGroupId('1@g.us') && !isGroupId('1@c.us'));
ok('isGroupId distingue grupo de contato');

// --- MessageWindow + gancho de primeira visão ---
const seen: string[] = [];
const win = new MessageWindow(3, 60_000, (g, m) => seen.push(`${g}:${m}`));
win.track('g@g.us', 'm1', Date.now());
win.track('g@g.us', 'm1', Date.now()); // duplicada
win.track('g@g.us', 'm2', Date.now());
assert.deepStrictEqual(seen, ['g@g.us:m1', 'g@g.us:m2'], 'gancho dispara uma vez por mensagem');
assert.strictEqual(win.ids('g@g.us').size, 2);
ok('MessageWindow deduplica e avisa só na primeira visão');

win.track('g@g.us', 'm3', Date.now());
win.track('g@g.us', 'm4', Date.now());
assert.strictEqual(win.size('g@g.us'), 3, 'respeita maxSize=3');
ok('MessageWindow limita pelo tamanho máximo');

const old = new MessageWindow(10, 1000, undefined);
old.track('g@g.us', 'antiga', Date.now() - 5000);
assert.strictEqual(old.ids('g@g.us').size, 0, 'mensagem fora da janela de idade sai');
ok('MessageWindow expira por idade');

// --- JsonlSink ---
const dir = mkdtempSync(path.join(tmpdir(), 'wa-sink-'));
const file = path.join(dir, 'events.jsonl');
const sink = new JsonlSink({ filePath: file, maxBytes: 10 * 1024 * 1024 });

const mk = (i: number): CapturedEvent => ({
  schema: EVENT_SCHEMA_VERSION,
  eventId: `id-${i}`,
  type: 'message',
  capturedAt: new Date().toISOString(),
  group: { id: 'g@g.us', name: 'G' },
  actor: { id: 'a@c.us', phone: '+1', name: null, nameSource: null },
  payload: {
    messageId: `m${i}`, sentAt: null, messageType: 'chat', body: `linha ${i}`,
    caption: null, isMedia: false, mimetype: null, fromMe: false,
    quotedMsgId: null, mentionedIds: [], backfill: false,
  },
});

async function run() {
  // 200 escritas concorrentes: valida a fila serializada (sem linhas intercaladas).
  await Promise.all(Array.from({ length: 200 }, (_, i) => sink.write(mk(i))));
  await sink.close();

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 200, `esperava 200 linhas, veio ${lines.length}`);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepStrictEqual(parsed.map((p) => p.eventId), Array.from({ length: 200 }, (_, i) => `id-${i}`));
  ok('JsonlSink grava 200 escritas concorrentes em ordem, sem linha corrompida');
  rmSync(dir, { recursive: true, force: true });

  console.log('\nSmoke test\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
