/*
 * A garantia central do desenho: reprocessar um evento não conta duas vezes.
 *
 * Usa um driver falso que imita só o que o Ingestor precisa do MongoDB —
 * `bulkWrite` com `upsertedIds` e `updateOne` com `modifiedCount`. Sem rede,
 * sem banco, sem sessão do WhatsApp.
 */
import assert from 'node:assert';

import { Ingestor, rawEventId } from '../src/mongo/ingest';
import { resolvePersonId, resolveIdentity } from '../src/mongo/identity';
import { EVENT_SCHEMA_VERSION, type CapturedEvent } from '../src/types';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

const GROUP = '120363428946452522@g.us';

// --- driver falso -----------------------------------------------------------

interface FakeDoc { _id: string; [key: string]: unknown }

/**
 * Coleção em memória. Guarda os `$inc` aplicados para que o teste possa
 * afirmar sobre contadores, e respeita a semântica de upsert que o Ingestor
 * usa para saber o que é novo.
 */
class FakeCollection {
  readonly docs = new Map<string, FakeDoc>();
  readonly incs: Array<{ id: string; field: string; delta: number }> = [];

  async bulkWrite(ops: any[], _options?: unknown) {
    const upsertedIds: Record<number, string> = {};
    ops.forEach((op, index) => {
      const spec = op.updateOne;
      if (!spec) return;
      const id = spec.filter._id;
      if (typeof id !== 'string') return;

      const existed = this.docs.has(id);
      // Filtro com condição extra (o `$ne` do vínculo de grupo): só aplica
      // quando a condição bate.
      if (spec.filter['groups.groupId'] && existed) {
        const doc = this.docs.get(id) as { groups?: Array<{ groupId: string }> };
        const wanted = spec.filter['groups.groupId'].$ne;
        if ((doc.groups ?? []).some((g) => g.groupId === wanted)) return;
      }

      if (!existed) {
        if (spec.upsert !== true) return; // sem upsert, nada acontece
        this.docs.set(id, { _id: id });
        upsertedIds[index] = id;
      }
      this.applyUpdate(id, spec.update, !existed);
    });
    return { upsertedIds, modifiedCount: ops.length };
  }

  async updateOne(filter: any, update: any) {
    const id = filter._id;
    const doc = this.docs.get(id);
    // O filtro de desativação exige `active: true`.
    if (!doc || (filter.active === true && doc.active !== true)) {
      return { modifiedCount: 0 };
    }
    this.applyUpdate(id, update, false);
    return { modifiedCount: 1 };
  }

  private applyUpdate(id: string, update: any, inserted: boolean) {
    const doc = this.docs.get(id);
    if (!doc || !update) return;
    // `$setOnInsert` só vale na criação — é justamente o que protege authorId e
    // os rollups de serem reescritos por um reprocessamento.
    Object.assign(doc, update.$set ?? {}, inserted ? (update.$setOnInsert ?? {}) : {});
    for (const [field, delta] of Object.entries(update.$inc ?? {})) {
      doc[field] = ((doc[field] as number) ?? 0) + (delta as number);
      this.incs.push({ id, field, delta: delta as number });
    }
    // `$max`/`$min` num campo ausente gravam o valor — é assim que o primeiro
    // evento de uma pessoa fixa firstSeenAt/lastSeenAt.
    for (const [field, value] of Object.entries(update.$max ?? {})) {
      const current = doc[field] as Date | undefined;
      if (current === undefined || (value as Date) > current) doc[field] = value;
    }
    for (const [field, value] of Object.entries(update.$min ?? {})) {
      const current = doc[field] as Date | undefined;
      if (current === undefined || (value as Date) < current) doc[field] = value;
    }
    for (const [field, value] of Object.entries(update.$push ?? {})) {
      const current = (doc[field] as unknown[]) ?? [];
      doc[field] = [...current, value];
    }
    for (const [field, spec] of Object.entries(update.$addToSet ?? {})) {
      const current = new Set((doc[field] as unknown[]) ?? []);
      const values = (spec as { $each?: unknown[] })?.$each ?? [spec];
      for (const v of values) current.add(v);
      doc[field] = [...current];
    }
  }

  counter(id: string, field: string): number {
    return (this.docs.get(id)?.[field] as number) ?? 0;
  }
}

class FakeStore {
  readonly collections = new Map<string, FakeCollection>();
  name(logical: string) { return `${logical}_teste`; }
  async collection(logical: string) {
    let col = this.collections.get(logical);
    if (!col) { col = new FakeCollection(); this.collections.set(logical, col); }
    return col;
  }
  async connect() { return {}; }
  async close() {}
  get(logical: string): FakeCollection {
    const col = this.collections.get(logical);
    assert.ok(col, `coleção ${logical} não foi tocada`);
    return col;
  }
}

// --- fábricas de evento -----------------------------------------------------

function message(id: string, opts: Partial<{
  phone: string | null; actorId: string; body: string; quoted: string | null;
  sentAt: string; media: boolean; mentions: string[];
}> = {}): CapturedEvent {
  const actorId = opts.actorId ?? '146926720831515@lid';
  return {
    schema: EVENT_SCHEMA_VERSION,
    eventId: `uuid-${Math.random()}`, // muda a cada emissão, de propósito
    type: 'message',
    capturedAt: '2026-08-12T18:00:00.000Z',
    group: { id: GROUP, name: 'RADAR' },
    actor: {
      id: actorId,
      phone: opts.phone === undefined ? '+5511988812345' : opts.phone,
      name: 'Raphael',
      nameSource: 'pushname',
    },
    payload: {
      messageId: id,
      sentAt: opts.sentAt ?? '2026-08-12T18:00:00.000Z',
      messageType: 'chat',
      body: opts.body ?? 'olá pessoal',
      caption: null,
      isMedia: opts.media ?? false,
      mimetype: null,
      fromMe: false,
      quotedMsgId: opts.quoted ?? null,
      mentionedIds: opts.mentions ?? [],
      backfill: false,
    },
  };
}

function reaction(target: string, emoji = '❤️', actorId = '117574830403792@lid'): CapturedEvent {
  return {
    schema: EVENT_SCHEMA_VERSION,
    eventId: `uuid-${Math.random()}`,
    type: 'reaction_added',
    capturedAt: '2026-08-12T18:05:00.000Z',
    group: { id: GROUP, name: 'RADAR' },
    actor: { id: actorId, phone: '+5521994312345', name: 'Lívia', nameSource: 'pushname' },
    payload: { targetMessageId: target, emoji, reactedAt: '2026-08-12T18:05:00.000Z' },
  };
}

/** Alguém abriu uma mensagem que a própria conta enviou. */
function leitura(target: string, actorId = '117574830403792@lid'): CapturedEvent {
  return {
    schema: EVENT_SCHEMA_VERSION,
    eventId: `uuid-${Math.random()}`,
    type: 'message_read',
    capturedAt: '2026-08-12T18:10:00.000Z',
    group: { id: GROUP, name: 'RADAR' },
    actor: { id: actorId, phone: '+5521994312345', name: 'Lívia', nameSource: 'pushname' },
    payload: {
      targetMessageId: target,
      readAt: '2026-08-12T18:09:00.000Z',
      source: 'store-query',
    },
  };
}

function unreaction(target: string, emoji = '❤️', actorId = '117574830403792@lid'): CapturedEvent {
  return {
    ...(reaction(target, emoji, actorId) as CapturedEvent),
    type: 'reaction_removed',
    payload: { targetMessageId: target, emoji, reactedAt: null },
  } as CapturedEvent;
}

// --- testes -----------------------------------------------------------------

async function run() {
  // === 1. reprocessar não conta duas vezes ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);
    const events = [message('m1'), message('m2'), reaction('m1')];

    await ingestor.apply(events);
    const people = store.get('people');
    const groups = store.get('groups');

    const autor = '5511988812345';
    assert.strictEqual(people.counter(autor, 'messagesSent'), 2);
    assert.strictEqual(groups.counter(GROUP, 'totalMessages'), 2);
    assert.strictEqual(people.counter('5521994312345', 'reactionsGiven'), 1);
    ok('primeira passada conta mensagens e reações');

    // Mesmíssimos eventos, eventId novo (é o que acontece num reimport).
    await ingestor.apply([message('m1'), message('m2'), reaction('m1')]);

    assert.strictEqual(people.counter(autor, 'messagesSent'), 2, 'não pode virar 4');
    assert.strictEqual(groups.counter(GROUP, 'totalMessages'), 2, 'grupo não pode dobrar');
    assert.strictEqual(people.counter('5521994312345', 'reactionsGiven'), 1);
    ok('REPROCESSAR O MESMO EVENTO NÃO INCREMENTA NADA');

    // E uma terceira vez, para garantir que não é só o segundo caso.
    await ingestor.apply(events);
    assert.strictEqual(people.counter(autor, 'messagesSent'), 2);
    ok('idempotente também na terceira passada');
  }

  // === 2. reação antes da mensagem alvo não perde o crédito ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    // O backfill lê o histórico fora de ordem: a reação chega primeiro.
    await ingestor.apply([reaction('m-tardia')]);
    const messages = store.get('messages');
    assert.strictEqual(
      messages.docs.has('m-tardia'), false,
      'a mensagem alvo ainda não existe',
    );

    await ingestor.apply([message('m-tardia')]);
    assert.ok(messages.docs.has('m-tardia'), 'a mensagem chega depois');

    // O rollup ficou registrado na coleção de reações, que é de onde o
    // recálculo soma `reactionsReceived` — o crédito não se perdeu.
    const reactions = store.get('reactions');
    const doc = [...reactions.docs.values()][0];
    assert.ok(doc, 'a reação foi persistida mesmo sem a mensagem');
    assert.strictEqual(doc.targetMessageId, 'm-tardia');
    assert.strictEqual(doc.active, true);
    ok('reação que chega antes da mensagem sobrevive para o recálculo');

    // A mensagem que chegou depois não pode ter zerado o rollup dela.
    const messageDoc = messages.docs.get('m-tardia');
    assert.strictEqual(
      messageDoc?.reactionsCount, 0,
      'o $setOnInsert só vale na criação e não apaga incremento posterior',
    );
    ok('a chegada da mensagem não sobrescreve rollups já contados');
  }

  // === 3. remover reação decrementa uma única vez ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    await ingestor.apply([message('m1'), reaction('m1')]);
    const people = store.get('people');
    assert.strictEqual(people.counter('5521994312345', 'reactionsGiven'), 1);

    await ingestor.apply([unreaction('m1')]);
    assert.strictEqual(people.counter('5521994312345', 'reactionsGiven'), 0);
    ok('remover reação decrementa');

    // Uma segunda remoção não tem o que desfazer.
    await ingestor.apply([unreaction('m1')]);
    assert.strictEqual(
      people.counter('5521994312345', 'reactionsGiven'), 0,
      'não pode ficar negativo',
    );
    ok('remover duas vezes não deixa o contador negativo');
  }

  // === 3b. a mesma reação com e sem telefone resolvido é UMA reação ===
  {
    // Caso real do events.jsonl: o mesmo ator reagiu uma vez, mas o roster
    // resolveu o telefone entre uma emissão e outra. Se a chave da reação
    // dependesse do personId, viraria duas reações — e a pessoa apareceria
    // reagindo o dobro do que reagiu.
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    const semTelefone = reaction('m1', '❤️', '237194031669378@lid');
    (semTelefone.actor as { phone: string | null }).phone = null;
    const comTelefone = reaction('m1', '❤️', '237194031669378@lid');
    (comTelefone.actor as { phone: string | null }).phone = '+5511945299054';

    await ingestor.apply([message('m1'), semTelefone, comTelefone]);

    assert.strictEqual(
      store.get('reactions').docs.size, 1,
      'uma reação só, não uma por forma de identificar a pessoa',
    );
    ok('mesma reação com e sem telefone resolvido não vira duas');
  }

  // === 3c. reprocessar não desfaz a fusão de identidade ===
  {
    // O recálculo reponta `authorId` quando funde um `lid:` provisório com a
    // pessoa de telefone conhecido. Se o reprocessamento reescrevesse esse
    // campo, a identidade ficaria oscilando entre as duas a cada importação.
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    await ingestor.apply([message('m1', { phone: null, actorId: '199372465811459@lid' })]);
    const messages = store.get('messages');
    assert.strictEqual(messages.docs.get('m1')?.authorId, 'lid:199372465811459');

    // Simula o repontamento feito pela fusão.
    messages.docs.get('m1')!.authorId = '5511988812345';

    await ingestor.apply([message('m1', { phone: null, actorId: '199372465811459@lid' })]);
    assert.strictEqual(
      messages.docs.get('m1')?.authorId, '5511988812345',
      'o reprocessamento não pode reverter a fusão',
    );
    ok('reprocessar não desfaz o repontamento da fusão de identidade');
  }

  // === 4. LID sem telefone vira id provisório, e o alias fica registrado ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    await ingestor.apply([message('m1', { phone: null, actorId: '199372465811459:71@lid' })]);
    const people = store.get('people');

    const pending = [...people.docs.keys()].find((k) => k.startsWith('lid:'));
    assert.strictEqual(pending, 'lid:199372465811459', 'sufixo de dispositivo normalizado');

    const aliases = people.docs.get(pending!)?.aliases as string[];
    assert.ok(aliases.includes('199372465811459@lid'), 'guarda o alias para a fusão futura');
    ok('LID sem telefone vira lid: provisório com alias rastreável');
  }

  // === 5. o mesmo lote com o id repetido não conta duas vezes ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    // Backfill e listener ao vivo podem entregar a mesma mensagem no mesmo lote.
    await ingestor.apply([message('dup'), message('dup')]);
    assert.strictEqual(store.get('people').counter('5511988812345', 'messagesSent'), 1);
    ok('id repetido dentro do mesmo lote conta uma vez só');
  }

  // === 6. respostas e mídia ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    await ingestor.apply([
      message('m1'),
      message('m2', { quoted: 'm1', media: true, mentions: ['5511111111111@c.us'] }),
    ]);

    const people = store.get('people');
    const autor = '5511988812345';
    assert.strictEqual(people.counter(autor, 'repliesSent'), 1);
    assert.strictEqual(people.counter(autor, 'mediaSent'), 1);
    assert.strictEqual(people.counter(autor, 'mentionsMade'), 1);
    assert.strictEqual(store.get('groups').counter(GROUP, 'messagesWithReply'), 1);
    // A mensagem citada acumula o rollup; quem a escreveu é creditado no
    // recálculo, somando por autor.
    assert.strictEqual(store.get('messages').counter('m1', 'repliesCount'), 1);
    ok('resposta, mídia e menção são contadas nos campos certos');
  }

  // === 7. série diária ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);
    await ingestor.apply([
      message('m1', { sentAt: '2026-08-12T18:00:00.000Z' }),
      message('m2', { sentAt: '2026-08-12T19:00:00.000Z' }),
    ]);

    const daily = store.get('activity_daily');
    // 18h UTC = 15h em São Paulo, mesmo dia.
    const groupRow = daily.docs.get(`${GROUP}|_all|2026-08-12`);
    assert.ok(groupRow, 'linha agregada do grupo existe');
    assert.strictEqual(groupRow.messages, 2);
    const personRow = daily.docs.get(`${GROUP}|5511988812345|2026-08-12`);
    assert.ok(personRow, 'linha da pessoa existe');
    assert.strictEqual(personRow.messages, 2);
    ok('série diária separa a linha do grupo da linha da pessoa');
  }

  // === 8. snapshot não vira documento, mas registra o membro silencioso ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    const snapshot: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: 'uuid-snap',
      type: 'group_snapshot',
      capturedAt: '2026-08-12T18:00:00.000Z',
      group: { id: GROUP, name: 'RADAR' },
      actor: null,
      payload: {
        subject: 'RADAR TABATA #04',
        description: null,
        owner: null,
        participantCount: 1,
        participants: [{
          id: '5511955554444@c.us', phone: '+5511955554444',
          name: 'Calada', nameSource: 'contact', isAdmin: false, isSuperAdmin: false,
        }],
        reason: 'boot',
      },
    };

    await ingestor.apply([snapshot]);

    const people = store.get('people');
    assert.ok(people.docs.has('5511955554444'), 'quem nunca falou também vira pessoa');
    assert.strictEqual(people.counter('5511955554444', 'messagesSent'), 0);
    const groups = (people.docs.get('5511955554444')?.groups ?? []) as Array<{ groupId: string }>;
    assert.strictEqual(groups[0]?.groupId, GROUP, 'com o vínculo de grupo gravado');
    ok('snapshot registra o membro silencioso sem virar documento histórico');

    // E o log bruto não guarda snapshot — era o maior consumidor de espaço.
    const raw = store.collections.get('events');
    assert.ok(!raw || raw.docs.size === 0, 'snapshot fica fora do log bruto');
    ok('snapshot não entra no log bruto');
  }

  // === 9. _id do log bruto é determinístico ===
  {
    const a = rawEventId(message('m1'));
    const b = rawEventId(message('m1'));
    assert.strictEqual(a, b, 'o mesmo conteúdo dá sempre o mesmo _id');
    assert.ok(a?.startsWith('msg|'));
    ok('_id do log bruto não depende do eventId');
  }

  // === 9b. leitura de mensagem própria ===
  {
    const store = new FakeStore();
    const ingestor = new Ingestor(store as never, true);

    await ingestor.apply([message('minha'), leitura('minha')]);
    const people = store.get('people');
    const messages = store.get('messages');
    const reads = store.get('message_reads');

    assert.strictEqual(people.counter('5521994312345', 'messagesRead'), 1);
    assert.strictEqual(messages.docs.get('minha')?.readsCount, 1, 'rollup na mensagem lida');
    assert.strictEqual(store.get('groups').counter(GROUP, 'totalReads'), 1);
    ok('leitura conta para a pessoa, para a mensagem e para o grupo');

    // Reimport: eventId novo, mesmo fato.
    await ingestor.apply([message('minha'), leitura('minha')]);
    assert.strictEqual(people.counter('5521994312345', 'messagesRead'), 1, 'não pode virar 2');
    assert.strictEqual(messages.docs.get('minha')?.readsCount, 1);
    assert.strictEqual(reads.docs.size, 1, 'um documento por pessoa por mensagem');
    ok('REPROCESSAR LEITURA NÃO CONTA DUAS VEZES');

    // Ler NÃO é falar: `lastMessageAt` não pode se mexer com leitura.
    const doc = people.docs.get('5521994312345') as { lastMessageAt?: Date; lastSeenAt?: Date };
    assert.strictEqual(doc.lastMessageAt, undefined, 'leitura não vira atividade de fala');
    assert.ok(doc.lastSeenAt, 'mas conta como presença');
    ok('leitura mexe em lastSeenAt e não em lastMessageAt');

    // Fora do log bruto: é o evento de maior cardinalidade e não tem conteúdo
    // a preservar além do que `message_reads` já guarda.
    const cru = store.collections.get('events');
    const tiposNoLogBruto = [...(cru?.docs.values() ?? [])].map((d) => d.type);
    assert.ok(!tiposNoLogBruto.includes('message_read'), 'leitura fica fora do log bruto');
    assert.ok(tiposNoLogBruto.includes('message'), 'mas a mensagem continua lá');
    ok('message_read não vai para o log bruto');

    const chave = rawEventId(leitura('minha'));
    assert.strictEqual(chave, rawEventId(leitura('minha')), '_id do log bruto é estável');
    assert.ok(chave?.startsWith('rd|'));
    ok('_id do log bruto da leitura não depende do eventId nem do horário');
  }

  // === 10. identidade ===
  {
    assert.strictEqual(
      resolvePersonId({ id: '199372465811459:71@lid', phone: null, name: null, nameSource: null }),
      'lid:199372465811459',
    );
    assert.strictEqual(
      resolvePersonId({ id: '199372465811459@lid', phone: '+5511988812345', name: null, nameSource: null }),
      '5511988812345',
      'com telefone, o telefone manda',
    );
    const identity = resolveIdentity({
      id: '146926720831515@lid', phone: '+5511988812345', name: 'X', nameSource: 'pushname',
    });
    assert.strictEqual(identity?.ddd, '11');
    assert.ok(identity?.aliases.includes('146926720831515@lid'));
    assert.ok(identity?.aliases.includes('5511988812345@c.us'), 'os dois ids viram alias');
    ok('identidade prefere telefone e guarda os dois ids como alias');
  }

  console.log('\ningest\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
