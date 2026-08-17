/* Testa checkpoint (dedupe + diff de participantes) e normalização de LID. */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CheckpointStore } from '../src/state/checkpoint';
import { isLid, normalizeLid } from '../src/enrich/lid';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);
const G = 'g@g.us';

// --- LID ---
assert.ok(isLid('237194031669378@lid') && !isLid('551199@c.us'));
assert.strictEqual(normalizeLid('199372465811459:71@lid'), '199372465811459@lid');
assert.strictEqual(normalizeLid('237194031669378@lid'), '237194031669378@lid');
assert.strictEqual(normalizeLid('5511@c.us'), '5511@c.us');
ok('normalizeLid remove o sufixo de dispositivo e ignora não-LIDs');

// --- checkpoint: dedupe ---
const dir = mkdtempSync(path.join(tmpdir(), 'wa-ckpt-'));
let store = new CheckpointStore(dir);

assert.strictEqual(store.isFirstRun(G), true);
assert.strictEqual(store.markMessageEmitted(G, 'm1', 1000), true, 'primeira vez emite');
assert.strictEqual(store.markMessageEmitted(G, 'm1', 1000), false, 'segunda vez é bloqueada');
assert.strictEqual(store.markMessageEmitted(G, 'm2', 2000), true);
ok('markMessageEmitted bloqueia reemissão da mesma mensagem');

assert.strictEqual(store.get(G).lastMessageAt, 2000);
assert.strictEqual(store.get(G).lastMessageId, 'm2');
assert.strictEqual(store.markMessageEmitted(G, 'm0', 500), true, 'mensagem antiga ainda emite');
assert.strictEqual(store.get(G).lastMessageAt, 2000, 'mas não retrocede o checkpoint');
ok('lastMessageAt avança só para frente');

// --- checkpoint: participantes ---
// Primeiro contato mesmo tendo emitido mensagens antes: é o cenário real do
// backfill, que grava mensagens e só depois reconcilia os participantes.
const d1 = store.diffParticipants(G, ['a@c.us', 'b@c.us']);
assert.deepStrictEqual([d1.firstRun, d1.added, d1.removed], [true, [], []]);
ok('primeiro diff não inventa entradas, mesmo após o backfill mexer no checkpoint');

// Lista vazia (metadados ainda não sincronizados) não pode apagar o que sabemos
// nem virar diferença: o consumidor emite um `remove` por id devolvido aqui, e
// um grupo inteiro "saindo" é sempre falha de sincronização, nunca um fato.
const vazio = store.diffParticipants(G, []);
assert.deepStrictEqual([vazio.added, vazio.removed], [[], []], 'lista vazia não gera diff');
assert.deepStrictEqual(store.get(G).participantIds, ['a@c.us', 'b@c.us'], 'nem grava vazio');
ok('lista vazia não vira saída em massa nem sobrescreve os participantes conhecidos');

// Mesma história com a lista quebrada que o WA Web devolve às vezes: tamanho
// certo, contatos sem id. Os ids vazios não são pessoas e ficam de fora.
const semId = store.diffParticipants(G, ['a@c.us', '', '', 'b@c.us']);
assert.deepStrictEqual([semId.added, semId.removed], [[], []], 'id vazio não é participante');
assert.deepStrictEqual(store.get(G).participantIds, ['a@c.us', 'b@c.us'], 'e não é gravado');
ok('participante sem id é descartado em vez de virar entrada ou saída');

const d2 = store.diffParticipants(G, ['b@c.us', 'c@c.us']);
assert.deepStrictEqual(d2.added, ['c@c.us']);
assert.deepStrictEqual(d2.removed, ['a@c.us']);
ok('diff detecta quem entrou e quem saiu');

// --- persistência através de restart ---
store.save();
store = new CheckpointStore(dir);
assert.strictEqual(store.markMessageEmitted(G, 'm1', 1000), false, 'dedupe sobrevive ao restart');
assert.strictEqual(store.get(G).lastMessageAt, 2000);
const d3 = store.diffParticipants(G, ['b@c.us', 'c@c.us', 'd@c.us']);
assert.deepStrictEqual(d3.added, ['d@c.us'], 'diff continua da lista salva');
assert.deepStrictEqual(d3.removed, []);
ok('checkpoint sobrevive ao restart: dedupe e diff continuam de onde pararam');

// --- grupo novo continua sendo primeiro contato ---
assert.strictEqual(store.isFirstRun('outro@g.us'), true);
const d4 = store.diffParticipants('outro@g.us', ['x@c.us']);
assert.strictEqual(d4.firstRun, true);
ok('grupo ainda não visto é tratado como primeiro contato');

rmSync(dir, { recursive: true, force: true });
console.log('\nSmoke test — retomada\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`);
