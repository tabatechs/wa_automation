/*
 * O mesmo LID chega ora com sufixo de dispositivo, ora sem. Sem normalizar, a
 * mesma pessoa vira dois atores diferentes e todas as métricas se dividem.
 */
import assert from 'node:assert';

import type { Client } from '@open-wa/wa-automate';
import { Roster } from '../src/enrich/roster';
import { normalizeLid, isLid } from '../src/enrich/lid';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

const G = '120363000000000000@g.us';

// --- normalizeLid isolado ---
assert.strictEqual(normalizeLid('199372465811459:71@lid'), '199372465811459@lid');
assert.strictEqual(normalizeLid('199372465811459@lid'), '199372465811459@lid');
assert.strictEqual(normalizeLid('5511999998888@c.us'), '5511999998888@c.us', 'não mexe em @c.us');
assert.ok(isLid('1@lid') && !isLid('1@c.us'));
ok('normalizeLid remove o sufixo de dispositivo e ignora o resto');

/** Client falso: sem página (o store não é consultado) e com um contato fixo. */
function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    getPage: () => null,
    getContact: async (id: string) => {
      calls.push(id);
      return { id, name: 'Fulano de Tal' };
    },
    getHostNumber: async () => '5511999998888',
    getGroupMembers: async () => [],
    ...overrides,
  };
  return { client: client as unknown as Client, calls };
}

async function run() {
  // --- LID com e sem sufixo de dispositivo colapsam num ator só ---
  {
    const { client, calls } = fakeClient();
    const roster = new Roster(client, 60_000);

    const comSufixo = await roster.resolve('199372465811459:71@lid');
    const semSufixo = await roster.resolve('199372465811459@lid');

    assert.ok(comSufixo && semSufixo);
    assert.strictEqual(comSufixo.id, '199372465811459@lid', 'id sai normalizado');
    assert.strictEqual(semSufixo.id, comSufixo.id, 'as duas formas dão o MESMO id');
    assert.strictEqual(
      calls.length,
      1,
      'a segunda chamada acerta o cache — prova que a chave também foi normalizada',
    );
    ok('LID com e sem sufixo de dispositivo viram um único ator');
  }

  // --- @c.us continua intocado e ganha telefone ---
  {
    const { client } = fakeClient();
    const roster = new Roster(client, 60_000);

    const actor = await roster.resolve('5511988812345@c.us');
    assert.ok(actor);
    assert.strictEqual(actor.id, '5511988812345@c.us');
    assert.strictEqual(actor.phone, '+5511988812345');
    assert.strictEqual(actor.name, 'Fulano de Tal');
    assert.strictEqual(actor.nameSource, 'contact');
    ok('@c.us mantém o id e deriva o telefone');
  }

  // --- LID que o store resolve para @c.us mantém o LID como id, mas ganha telefone ---
  {
    const { client } = fakeClient({
      getPage: () => ({
        evaluate: async () => '5511988812345@c.us',
      }),
    });
    const roster = new Roster(client, 60_000);

    const actor = await roster.resolve('199372465811459:71@lid');
    assert.ok(actor);
    assert.strictEqual(actor.id, '199372465811459@lid', 'a chave estável continua sendo o LID');
    assert.strictEqual(actor.phone, '+5511988812345', 'mas o telefone é resolvido pelo store');
    ok('LID resolvido pelo store mantém o id e ganha telefone');
  }

  // --- falha ao buscar o contato não perde o ator ---
  {
    const { client } = fakeClient({
      getContact: async () => { throw new Error('boom'); },
    });
    const roster = new Roster(client, 60_000);

    const actor = await roster.resolve('5511988812345@c.us');
    assert.ok(actor, 'getContact falhou, mas o ator sobrevive');
    assert.strictEqual(actor.phone, '+5511988812345');
    assert.strictEqual(actor.name, null);
    ok('erro no getContact custa o nome, não o evento');
  }

  // --- lista de participantes quebrada não substitui a boa ---
  // O WA Web às vezes falha em montar os ids ("this.$1 is not a function") e o
  // open-wa devolve a lista com o tamanho certo e os contatos vazios. Aceitar
  // isso fez um grupo de 813 acusar 723 saídas de uma vez.
  {
    const quebrada = [{ id: '5511988812345@c.us', name: 'A' }, {}, {}];
    const inteira = [
      { id: '5511988812345@c.us', name: 'A' },
      { id: '5511977712345@c.us', name: 'B' },
    ];

    // Sem nenhuma lista boa antes: melhor devolver nada do que uma lista
    // menor. O consumidor trata "vazio" como falta de informação; uma lista
    // parcial ele leria como as pessoas que faltam tendo saído.
    const semHistorico = new Roster(fakeClient({ getGroupMembers: async () => quebrada }).client, 60_000);
    assert.deepStrictEqual(await semHistorico.groupMembers(G), [], 'lista parcial é descartada');
    ok('lista de participantes com contato sem id é descartada por inteiro');

    let boa = true;
    const { client } = fakeClient({ getGroupMembers: async () => (boa ? inteira : quebrada) });
    const roster = new Roster(client, 60_000);

    assert.strictEqual((await roster.groupMembers(G)).length, 2, 'a lista boa passa inteira');

    boa = false;
    roster.invalidateGroup(G);
    const depois = await roster.groupMembers(G);
    assert.deepStrictEqual(
      depois.map((p) => p.id),
      ['5511988812345@c.us', '5511977712345@c.us'],
      'a última lista boa continua valendo',
    );
    ok('lista quebrada não substitui a última lista boa, nem com o cache invalidado');
  }

  console.log('\nroster\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
