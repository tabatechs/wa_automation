/*
 * A conta que nenhuma soma por grupo dá: quantas pessoas distintas existem no
 * conjunto dos grupos. A mesma pessoa costuma estar em vários, então somar
 * `memberCount` a conta tantas vezes quantos grupos ela integra.
 *
 * Usa um `db` falso com o pouco que o recálculo pede — `find().project().sort()`
 * iterável, `bulkWrite` e `aggregate`. Sem rede e sem banco.
 */
import assert from 'node:assert';

import { MetricsBuilder } from '../src/mongo/metrics';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

interface Linha {
  _id: string;
  groupId: string;
  date: string;
  members: string[];
  memberCount?: number;
}

/** O que o estágio escreveu, achatado por `_id`. */
type Escrita = { id: string; set: Record<string, unknown> };

function fakeDb(linhas: Linha[]) {
  const escritas: Escrita[] = [];
  const collection = {
    find() {
      return {
        project() {
          return {
            sort() {
              // O estágio depende da ordem por data para fechar um dia antes
              // de abrir o próximo.
              const ordenadas = [...linhas].sort((a, b) => a.date.localeCompare(b.date));
              return {
                async *[Symbol.asyncIterator]() {
                  for (const linha of ordenadas) yield linha;
                },
              };
            },
          };
        },
      };
    },
    async bulkWrite(ops: Array<{ updateOne: { filter: { _id: string }; update: { $set: Record<string, unknown> } } }>) {
      for (const op of ops) {
        escritas.push({ id: op.updateOne.filter._id, set: op.updateOne.update.$set });
      }
      return {};
    },
    aggregate() {
      return { async toArray() { return []; } };
    },
  };
  return { db: { collection: () => collection }, escritas };
}

async function run(): Promise<void> {
  const store = { name: (logical: string) => logical };
  const builder = new MetricsBuilder(store as never);
  const rebuild = (db: unknown): Promise<void> =>
    (builder as unknown as { rebuildMembershipDaily(db: unknown): Promise<void> })
      .rebuildMembershipDaily(db);

  // === 1. união do dia, acumulado e contagem por linha ===
  {
    const { db, escritas } = fakeDb([
      { _id: 'g1|2026-09-20', groupId: 'g1', date: '2026-09-20', members: ['a', 'b'] },
      { _id: 'g2|2026-09-20', groupId: 'g2', date: '2026-09-20', members: ['b', 'c'] },
      // Já contada: não deve gerar escrita nenhuma.
      { _id: 'g1|2026-09-21', groupId: 'g1', date: '2026-09-21', members: ['a', 'd'], memberCount: 2 },
    ]);
    await rebuild(db);

    const uniao = (date: string) => escritas.find((e) => e.id === `_all|${date}`)?.set;

    const dia20 = uniao('2026-09-20');
    assert.strictEqual(dia20?.memberCount, 3, 'a,b,c — o "b" dos dois grupos conta uma vez só');
    assert.strictEqual(dia20?.groups, 2);
    assert.strictEqual(dia20?.cumulativeMemberCount, 3);
    ok('a união do dia não conta duas vezes quem está em dois grupos');

    const dia21 = uniao('2026-09-21');
    assert.strictEqual(dia21?.memberCount, 2, 'a,d — só o que apareceu no dia');
    assert.strictEqual(
      dia21?.cumulativeMemberCount,
      4,
      'a,b,c,d — o acumulado atravessa os dias, e "a" não entra de novo',
    );
    ok('o acumulado soma gente nova e ignora quem já tinha sido contado');

    assert.deepStrictEqual(uniao('2026-09-20')?.members, [], 'a linha de união não repete os ids');
    ok('a união não duplica a lista de ids');

    const contagens = escritas.filter((e) => !e.id.startsWith('_all'));
    assert.deepStrictEqual(
      contagens.map((e) => e.id).sort(),
      ['g1|2026-09-20', 'g2|2026-09-20'],
      'a linha que já tinha memberCount certo não é reescrita',
    );
    assert.strictEqual(contagens[0]?.set.memberCount, 2);
    ok('memberCount só é gravado onde mudou');
  }

  // === 2. série vazia não escreve nada ===
  {
    const { db, escritas } = fakeDb([]);
    await rebuild(db);
    assert.strictEqual(escritas.length, 0);
    ok('sem linhas, o estágio não escreve');
  }

  console.log('\ncomposição diária\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
