/*
 * Grupos fora de `Store.Chat` só existem para o monitor pelo servidor. A lista
 * que vem de lá precisa sair em `@c.us`, ou a reconciliação lê a troca de
 * formato como saída em massa.
 */
import assert from 'node:assert';

import type { Client } from '@open-wa/wa-automate';
import { toDirectoryGroup, type DirectoryGroup, type GroupSource } from '../src/enrich/groupDirectory';
import { Roster } from '../src/enrich/roster';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

const G = '120363000000000000@g.us';
const wid = (s: string) => ({ _serialized: s, user: s.split('@')[0] });

// --- normalização ---
{
  const g = toDirectoryGroup(
    {
      id: wid(G),
      subject: 'Time Político',
      desc: { desc: 'descrição' },
      owner: wid('5511900000001@c.us'),
      participants: [
        { id: wid('5511900000001@c.us'), admin: 'superadmin' },
        { id: wid('111@lid'), phoneNumber: wid('5511900000002@c.us'), admin: 'admin' },
        { id: '5511900000003@c.us', isAdmin: false },
      ],
    },
    false,
  );
  assert.ok(g);
  assert.strictEqual(g.subject, 'Time Político');
  assert.strictEqual(g.description, 'descrição');
  assert.strictEqual(g.owner, '5511900000001@c.us');
  assert.deepStrictEqual(g.participants, [
    { id: '5511900000001@c.us', lid: null, isAdmin: true, isSuperAdmin: true },
    { id: '5511900000002@c.us', lid: '111@lid', isAdmin: true, isSuperAdmin: false },
    { id: '5511900000003@c.us', lid: null, isAdmin: false, isSuperAdmin: false },
  ]);
  ok('grupo do servidor sai com @c.us, LID ao lado e admin nas duas formas');
}

{
  // O formato real (16/09/2026): id sempre em @lid, telefone em phoneNumber,
  // e às vezes sem telefone nenhum — número escondido atrás de username.
  const g = toDirectoryGroup(
    {
      id: G,
      participants: [
        { id: wid('111:5@lid'), phoneNumber: wid('5511900000001@c.us') },
        { id: wid('222@lid'), username: 'fulano' },
      ],
    },
    false,
  );
  assert.deepStrictEqual(
    g?.participants?.map((p) => [p.id, p.lid]),
    [
      ['5511900000001@c.us', '111@lid'],
      ['222@lid', '222@lid'],
    ],
  );
  ok('telefone vira o id; sem telefone, o LID normalizado entra no lugar');
}

{
  const g = toDirectoryGroup({ id: G, participants: [{ id: '5511900000001@c.us' }, { username: 'x' }] }, false);
  assert.strictEqual(g?.participants, null);
  ok('participante sem id nenhum descarta a lista inteira');
}

assert.strictEqual(toDirectoryGroup({ id: '5511900000001@c.us' }, true), null);
ok('id que não é de grupo é ignorado');

// --- Roster com diretório ---
function directory(grupo: DirectoryGroup | null): GroupSource & { invalidacoes: number } {
  return {
    invalidacoes: 0,
    get: async () => grupo,
    invalidate() { this.invalidacoes += 1; },
  };
}

function client(members: unknown[] | (() => never)) {
  const calls = { members: 0 };
  const c = {
    getPage: () => null,
    getContact: async (id: string) => ({ id, name: 'Nome do Store' }),
    getGroupMembers: async () => {
      calls.members += 1;
      if (typeof members === 'function') return members();
      return members;
    },
  };
  return { client: c as unknown as Client, calls };
}

const fora: DirectoryGroup = {
  id: G,
  subject: 'Fora',
  description: null,
  owner: null,
  inStore: false,
  participants: [{ id: '5511900000009@c.us', lid: null, isAdmin: true, isSuperAdmin: false }],
};

async function run() {
  {
    const { client: c, calls } = client([]);
    const dir = directory(fora);
    const roster = new Roster(c, 60_000, dir);
    const inicio = Date.now();
    const membros = await roster.groupMembers(G, true);
    assert.strictEqual(calls.members, 0, 'nem pergunta ao store');
    assert.ok(Date.now() - inicio < 400, 'sem a espera com backoff');
    assert.deepStrictEqual(membros, [
      { id: '5511900000009@c.us', phone: '+5511900000009', name: null, nameSource: null, isAdmin: true, isSuperAdmin: false },
    ]);
    roster.invalidateGroup(G);
    assert.strictEqual(dir.invalidacoes, 1, 'mudança de participantes derruba o diretório também');
    ok('grupo fora da memória usa a lista do servidor, sem esperar');
  }

  {
    const { client: c, calls } = client([]);
    const roster = new Roster(c, 60_000, directory({ ...fora, participants: null }));
    const inicio = Date.now();
    assert.deepStrictEqual(await roster.groupMembers(G, true), []);
    assert.strictEqual(calls.members, 0);
    assert.ok(Date.now() - inicio < 400, 'esperar não traz o chat para a memória');
    ok('lista descartada vira vazio, que a reconciliação ignora');
  }

  {
    const { client: c, calls } = client([{ id: '5511900000008@c.us', name: 'Do Store' }]);
    const roster = new Roster(c, 60_000, directory({ ...fora, inStore: true }));
    const membros = await roster.groupMembers(G, true);
    assert.strictEqual(calls.members, 1);
    assert.deepStrictEqual(membros.map((m) => [m.id, m.name]), [['5511900000008@c.us', 'Do Store']]);
    ok('grupo em memória continua vindo do store, com nome');
  }

  {
    // Em memória mas o store devolveu vazio (boot de grupo grande): o servidor
    // cobre sem a espera.
    const { client: c } = client([]);
    const roster = new Roster(c, 60_000, directory({ ...fora, inStore: true }));
    assert.deepStrictEqual((await roster.groupMembers(G, true)).map((m) => m.id), ['5511900000009@c.us']);
    ok('store vazio em grupo conhecido cai na lista do servidor');
  }

  {
    const { client: c } = client([]);
    const roster = new Roster(c, 60_000, directory(null));
    assert.strictEqual(await roster.groupMeta(G), null);
    const semDiretorio = new Roster(c, 60_000);
    assert.strictEqual(await semDiretorio.groupMeta(G), null);
    ok('sem diretório, groupMeta devolve null e nada muda');
  }

  console.log('\ngroupDirectory\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
