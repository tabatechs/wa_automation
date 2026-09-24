/*
 * A lista oficial do dia: primeiro boot manda, reinício não mexe, fusão de
 * identidade não vira saída falsa. Sem rede e sem banco.
 */
import assert from 'node:assert';

import { Ingestor } from '../src/mongo/ingest';
import {
  canonicalResolver,
  decideRosterWrite,
  rosterFromSnapshot,
} from '../src/mongo/rosterDaily';
import { EVENT_SCHEMA_VERSION, type CapturedEvent, type ParticipantSnapshot } from '../src/types';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

const GROUP = '120363000000000000@g.us';

function membro(phone: string, isAdmin = false): ParticipantSnapshot {
  return {
    id: `${phone}@c.us`, phone: `+${phone}`,
    name: null, nameSource: null, isAdmin, isSuperAdmin: false,
  };
}

function snap(
  participants: ParticipantSnapshot[],
  at: string,
  reason: 'boot' | 'participants_changed' = 'boot',
): CapturedEvent {
  return {
    schema: EVENT_SCHEMA_VERSION,
    eventId: `uuid-${at}-${reason}`,
    type: 'group_snapshot',
    capturedAt: at,
    group: { id: GROUP, name: 'Grupo de exemplo' },
    actor: null,
    payload: {
      subject: 'Grupo de exemplo', description: null, owner: null,
      participantCount: participants.length, participants, reason,
    },
  };
}

/** Só o que o Ingestor usa: bulkWrite com upsert e `$setOnInsert`. */
class FakeCollection {
  readonly docs = new Map<string, Record<string, unknown>>();
  async bulkWrite(ops: any[]) {
    const upsertedIds: Record<number, string> = {};
    ops.forEach((op, i) => {
      const spec = op.updateOne;
      const id = spec?.filter?._id;
      if (typeof id !== 'string') return;
      let doc = this.docs.get(id);
      const novo = !doc;
      if (!doc) {
        if (!spec.upsert) return;
        doc = { _id: id };
        this.docs.set(id, doc);
        upsertedIds[i] = id;
      }
      Object.assign(doc, spec.update.$set ?? {}, novo ? (spec.update.$setOnInsert ?? {}) : {});
      // A união do dia (`group_members_daily`) cresce por `$addToSet`.
      for (const [campo, valor] of Object.entries(spec.update.$addToSet ?? {})) {
        const atual = new Set((doc[campo] as unknown[]) ?? []);
        for (const v of (valor as { $each?: unknown[] }).$each ?? [valor]) atual.add(v);
        doc[campo] = [...atual];
      }
    });
    return { upsertedIds };
  }
  async updateOne() { return { modifiedCount: 0 }; }
}

class FakeStore {
  readonly collections = new Map<string, FakeCollection>();
  async collection(logical: string) {
    let col = this.collections.get(logical);
    if (!col) { col = new FakeCollection(); this.collections.set(logical, col); }
    return col;
  }
}

async function run() {
  // === 1. só boot, só lista não vazia ===
  {
    const boot = rosterFromSnapshot(
      snap([membro('5511911111111', true), membro('5511922222222')], '2026-09-24T02:20:00.000-03:00'),
    );
    assert.ok(boot);
    assert.strictEqual(boot._id, `${GROUP}|2026-09-24`);
    assert.deepStrictEqual(boot.members.sort(), ['5511911111111', '5511922222222']);
    assert.deepStrictEqual(boot.admins, ['5511911111111']);
    ok('snapshot de boot vira candidata, com admins');

    const madrugadaUtc = rosterFromSnapshot(
      snap([membro('5511911111111')], '2026-09-24T02:30:00.000Z'),
    );
    assert.strictEqual(madrugadaUtc?.date, '2026-09-23', '02:30 UTC ainda é 23/09 em São Paulo');
    ok('o dia é o de São Paulo, também para evento antigo em UTC');

    assert.strictEqual(
      rosterFromSnapshot(snap([membro('5511911111111')], '2026-09-24T10:00:00.000-03:00', 'participants_changed')),
      null,
    );
    assert.strictEqual(rosterFromSnapshot(snap([], '2026-09-24T04:30:00.000-03:00')), null);
    ok('snapshot de mudança e boot vazio não viram lista oficial');
  }

  // === 2. o boot mais antigo ganha, e rodar de novo não muda nada ===
  {
    const cedo = rosterFromSnapshot(snap([membro('5511911111111')], '2026-09-24T02:20:00.000-03:00'))!;
    const tarde = rosterFromSnapshot(
      snap([membro('5511911111111'), membro('5511922222222')], '2026-09-24T04:30:00.000-03:00'),
    )!;
    assert.strictEqual(decideRosterWrite(null, tarde), 'insert');
    assert.strictEqual(decideRosterWrite(tarde, cedo), 'replace', 'o JSONL tem um boot anterior ao gravado');
    assert.strictEqual(decideRosterWrite(cedo, tarde), 'keep', 'reinício à tarde não mexe no número');
    assert.strictEqual(decideRosterWrite(cedo, cedo), 'keep', 'idempotente');
    assert.strictEqual(
      decideRosterWrite({ ...cedo, members: ['lid:999'] }, cedo),
      'repoint',
      'mesmo snapshot com id que mudou numa fusão',
    );
    ok('decisão: o boot mais antigo do dia é o oficial');
  }

  // === 3. caminho quente: primeiro boot fica, reinício não soma ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, false);
    await ingestor.apply([
      snap([membro('5511911111111'), membro('5511922222222')], '2026-09-23T04:30:00.000-03:00'),
    ]);
    // Reinício às 15h, em outro lote, com uma pessoa a mais e uma a menos.
    await ingestor.apply([
      snap([membro('5511911111111'), membro('5511933333333')], '2026-09-23T15:10:00.000-03:00'),
      snap([membro('5511911111111'), membro('5511944444444')], '2026-09-23T16:00:00.000-03:00', 'participants_changed'),
    ]);

    const roster = (await store.collection('group_roster_daily')).docs.get(`${GROUP}|2026-09-23`);
    assert.deepStrictEqual(
      (roster?.members as string[]).sort(),
      ['5511911111111', '5511922222222'],
      'a lista do primeiro boot não é reescrita nem somada',
    );
    assert.strictEqual(roster?.source, 'boot');

    const uniao = (await store.collection('group_members_daily')).docs.get(`${GROUP}|2026-09-23`);
    assert.strictEqual((uniao?.members as string[]).length, 4, 'group_members_daily continua sendo a união');
    ok('Ingestor grava só o primeiro boot do dia, sem tocar na união');
  }

  // === 4. dois boots no mesmo lote: o mais antigo, não o primeiro da fila ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, false);
    await ingestor.apply([
      snap([membro('5511933333333')], '2026-09-24T04:30:00.000-03:00'),
      snap([membro('5511911111111')], '2026-09-24T02:20:00.000-03:00'),
    ]);
    const roster = (await store.collection('group_roster_daily')).docs.get(`${GROUP}|2026-09-24`);
    assert.deepStrictEqual(roster?.members, ['5511911111111']);
    ok('dentro do lote vale o horário, não a ordem de chegada');
  }

  // === 5. ids antigos viram o _id atual de people ===
  {
    const resolve = canonicalResolver([
      // Um `lid:` fundido no telefone depois do snapshot.
      { _id: '5511955555555', aliases: ['5511955555555@c.us', '777@lid'], mergedFrom: ['lid:777'] },
      // Pendente ainda sem telefone.
      { _id: 'lid:888', aliases: ['888@lid'] },
    ]);
    const lidFundido: ParticipantSnapshot = {
      id: '777@lid', phone: null, name: null, nameSource: null, isAdmin: false, isSuperAdmin: false,
    };
    const lidComDispositivo: ParticipantSnapshot = { ...lidFundido, id: '777:12@lid' };
    const pendente: ParticipantSnapshot = { ...lidFundido, id: '888@lid' };
    const desconhecido = membro('5511966666666');

    assert.strictEqual(resolve(lidFundido), '5511955555555', 'mergedFrom leva ao destino da fusão');
    assert.strictEqual(resolve(lidComDispositivo), '5511955555555', 'sufixo de dispositivo não atrapalha');
    assert.strictEqual(resolve(pendente), 'lid:888', 'quem ainda é provisório fica provisório');
    assert.strictEqual(resolve(desconhecido), '5511966666666', 'quem não está em people mantém o id do evento');
    ok('a reconstrução usa o _id atual — fusão não vira saída falsa');
  }

  console.log('\nrosterDaily\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
