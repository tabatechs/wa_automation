/*
 * A whitelist de grupos é o controle de privacidade do projeto: o que não passa
 * por aqui nunca é gravado. Por isso ela é lida de forma estrita — id inválido
 * derruba o boot em vez de sumir calado.
 */
import assert from 'node:assert';

import { loadConfig, parseGroups } from '../src/config';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

// --- formato de MONITORED_GROUPS ---
assert.deepStrictEqual(
  parseGroups('1@g.us,\n2@g.us , 2@g.us\n#3@g.us\n\n').map((g) => g.id),
  ['1@g.us', '2@g.us'],
  'vírgula ou quebra de linha separam; repetido conta uma vez; "#" desliga',
);
assert.deepStrictEqual(parseGroups(''), [], 'lista vazia é lista vazia, não erro');
// Lista antiga, com rótulo depois do "=": o id continua valendo.
assert.deepStrictEqual(parseGroups('1@g.us=Rótulo antigo').map((g) => g.id), ['1@g.us']);
ok('parseGroups separa por vírgula ou linha, deduplica e respeita o "#"');

// Id errado precisa parar o boot: calado, ele viraria um grupo inteiro sem
// captura, e ninguém veria antes de ir procurar os dados.
assert.throws(() => parseGroups('1@g.us, 5511999998888@c.us'), /MONITORED_GROUPS/);
assert.throws(() => parseGroups('120363000000000000'), /@g\.us/);
ok('entrada que não é id de grupo interrompe o boot em vez de ser ignorada');

// --- config completa ---
const cfg = loadConfig();
assert.strictEqual(cfg.groupIds.size, cfg.groups.length, 'whitelist e Set em sincronia');
assert.ok(cfg.groups.every((g) => g.id.endsWith('@g.us')), 'só ids de grupo passam');
assert.ok(cfg.eventsFile.endsWith('data/events.jsonl'));
assert.ok(cfg.backfillDays > 0 && cfg.backfillMaxMessages > 0, 'defaults de backfill válidos');
ok('loadConfig monta a whitelist e os parâmetros a partir do ambiente');

console.log('\nconfig\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
