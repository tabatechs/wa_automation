/*
 * Mudanças de participantes.
 *
 * O risco coberto aqui é uma armadilha específica e cara: o tipo
 * `ParticipantChangedEventModel` do open-wa declara `who: string[]`, mas o WAPI
 * embutido chama o callback com uma STRING (`dist/lib/wapi.js:1238`). O código
 * lia só array, e o resultado foi 100% das entradas e saídas ao vivo gravadas
 * sem pessoa — 96 documentos com `personId: null` em produção antes de alguém
 * notar. Estes testes existem para que a forma do campo nunca mais seja
 * suposição.
 *
 * Sem rede, sem sessão: o CollectorContext é falso.
 */
import assert from 'node:assert';

import {
  ParticipantsCollector,
  extractId,
  participantIds,
} from '../src/collectors/participants';
import type { CollectorContext } from '../src/collectors/Collector';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

const G = '120363000000000001@g.us';
const LIVIA = '5521994312345@c.us';
const RAPHAEL = '5511988812345@c.us';

interface Emitido {
  type: string;
  who: string[];
  actorId: string | null;
}

/** Guarda o callback registrado para que o teste possa dispará-lo à mão. */
function makeCtx(emitidos: Emitido[]) {
  let handler: ((e: unknown) => Promise<void>) | null = null;

  const ctx = {
    client: {
      onGlobalParticipantsChanged: async (fn: (e: unknown) => Promise<void>) => {
        handler = fn;
        return true;
      },
    },
    config: { groups: [{ id: G }] },
    roster: {
      resolve: async (id: string | null) =>
        id ? { id, phone: id.split('@')[0] ?? null, name: null, nameSource: null } : null,
      resolveMany: async (ids: string[]) =>
        ids.map((id) => ({ id, phone: id.split('@')[0] ?? null, name: null, nameSource: null })),
      invalidateGroup: () => {},
      groupMembers: async () => [],
    },
    sink: { write: async () => {} },
    checkpoint: {} as never,
    isMonitored: (id: unknown): id is string => id === G,
    groupName: async () => 'Tabatech',
    emit: async (e: {
      type: string;
      actor: { id: string } | null;
      payload: { who?: Array<{ id: string }> };
    }) => {
      // group_snapshot também passa por aqui; só interessa o delta.
      if (e.type !== 'participants_changed') return;
      emitidos.push({
        type: e.type,
        who: (e.payload.who ?? []).map((a) => a.id),
        actorId: e.actor?.id ?? null,
      });
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;

  return { ctx, disparar: (e: unknown) => handler!(e) };
}

async function run() {
  // ---------- extractId ----------
  {
    assert.strictEqual(extractId(LIVIA), LIVIA);
    assert.strictEqual(extractId({ _serialized: LIVIA }), LIVIA);
    assert.strictEqual(extractId({ id: LIVIA }), LIVIA);
    assert.strictEqual(extractId({ id: { _serialized: LIVIA } }), LIVIA);
    assert.strictEqual(extractId('  '), null);
    assert.strictEqual(extractId(null), null);
    assert.strictEqual(extractId(42), null);
    ok('extractId aceita string, Wid e participante aninhado');
  }

  // ---------- participantIds ----------
  {
    // A forma que o WAPI embutido realmente manda, e que estava sendo perdida.
    assert.deepStrictEqual(participantIds(LIVIA), [LIVIA]);
    assert.deepStrictEqual(participantIds([LIVIA, RAPHAEL]), [LIVIA, RAPHAEL]);
    assert.deepStrictEqual(participantIds({ _serialized: LIVIA }), [LIVIA]);
    assert.deepStrictEqual(participantIds([]), []);
    assert.deepStrictEqual(participantIds(undefined), []);
    assert.deepStrictEqual(participantIds([LIVIA, LIVIA]), [LIVIA], 'sem repetido');
    assert.deepStrictEqual(participantIds([LIVIA, null, '']), [LIVIA], 'ignora vazio');
    ok('participantIds normaliza string, array e objeto — e não repete');
  }

  // ---------- o caminho completo, com a forma real do open-wa ----------
  {
    const emitidos: Emitido[] = [];
    const { ctx, disparar } = makeCtx(emitidos);
    await new ParticipantsCollector().start(ctx);

    // Exatamente o objeto de wapi.js:1238 — `who` é string, `by` é undefined.
    await disparar({ by: undefined, action: 'add', who: LIVIA, chat: G });

    assert.strictEqual(emitidos.length, 1, 'deve emitir um participants_changed');
    assert.deepStrictEqual(
      emitidos[0]?.who,
      [LIVIA],
      'a pessoa NÃO pode se perder quando `who` vem como string',
    );
    ok('evento no formato do WAPI embutido (who: string) preserva a pessoa');
  }

  // ---------- grupo fora da whitelist ----------
  {
    const emitidos: Emitido[] = [];
    const { ctx, disparar } = makeCtx(emitidos);
    await new ParticipantsCollector().start(ctx);

    await disparar({ action: 'add', who: LIVIA, chat: '120363999999999999@g.us' });

    assert.deepStrictEqual(emitidos, [], 'grupo não monitorado nunca é gravado');
    ok('a whitelist continua sendo a primeira linha do handler');
  }

  // ---------- chat como Wid, não string ----------
  {
    const emitidos: Emitido[] = [];
    const { ctx, disparar } = makeCtx(emitidos);
    await new ParticipantsCollector().start(ctx);

    // Antes, `String(event.chat)` dava "[object Object]" e o evento sumia.
    await disparar({ action: 'remove', who: [RAPHAEL], chat: { _serialized: G } });

    assert.strictEqual(emitidos.length, 1, 'chat como Wid não pode derrubar o evento');
    assert.deepStrictEqual(emitidos[0]?.who, [RAPHAEL]);
    ok('chat entregue como Wid ainda casa com a whitelist');
  }

  console.log(
    '\nSmoke test — mudanças de participantes\n' +
      out.join('\n') +
      `\n\n${out.length} verificações OK\n`,
  );
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
