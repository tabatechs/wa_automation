/*
 * Confirmação de leitura das mensagens próprias.
 *
 * O risco que estes testes cobrem é o mesmo das reações: o estado de quem já
 * foi emitido vive em disco, e um restart seguido de backfill não pode
 * transformar leituras antigas em eventos novos. Além disso, o custo aqui é por
 * MENSAGEM — então a vigilância precisa parar quando não há mais o que saber.
 *
 * Sem rede, sem sessão: a fonte de confirmação é substituída por uma de mentira.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReadReceiptsCollector, normalizeParticipant } from '../src/collectors/readReceipts';
import { MessageWindow } from '../src/collectors/messageWindow';
import type { CollectorContext } from '../src/collectors/Collector';
import type { MessageInfoResult, MessageInfoSource } from '../src/enrich/messageInfo';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

const G = '120363429416431036@g.us';
const MINHA = 'true_120363429416431036@g.us_3EB0MINHA_me';
const NOW = Date.now();
const EU = '5511900000000@c.us';
const LIVIA = '5521994312345@c.us';
const RAPHAEL = '5511988812345@c.us';

/** Fonte de confirmação controlada pelo teste; conta quantas vezes foi consultada. */
class FakeSource implements MessageInfoSource {
  readonly consultas: string[] = [];
  available = true;

  constructor(private readonly respostas: Map<string, MessageInfoResult | null>) {}

  async read(messageId: string): Promise<MessageInfoResult | null> {
    this.consultas.push(messageId);
    return this.respostas.get(messageId) ?? null;
  }
}

function info(leitores: string[], readRemaining: number | null = null): MessageInfoResult {
  return {
    readers: leitores.map((contactId) => ({
      contactId,
      readAt: new Date(NOW).toISOString(),
    })),
    readRemaining,
    source: 'store-query',
  };
}

interface Emitted {
  type: string;
  actorId: string;
  messageId: string;
}

function makeCtx(stateDir: string, emitted: Emitted[]): CollectorContext {
  return {
    client: {},
    config: {
      groups: [{ id: G }],
      readReceiptsEnabled: true,
      readReceiptPollMs: 60_000,
      readReceiptWindowMs: 48 * 3600e3,
      readReceiptMaxPerCycle: 40,
      backfillDays: 7,
      stateDir,
    },
    roster: {
      resolve: async (id: string) => ({ id, phone: null, name: null, nameSource: null }),
      resolveSelf: async () => ({ id: EU, phone: null, name: 'eu', nameSource: null }),
    },
    sink: { write: async () => {} },
    checkpoint: {} as never,
    isMonitored: (id: unknown): id is string => id === G,
    groupName: async () => 'Tabatech',
    emit: async (e: { type: string; actor: { id: string }; payload: { targetMessageId: string } }) => {
      emitted.push({ type: e.type, actorId: e.actor.id, messageId: e.payload.targetMessageId });
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;
}

/** Monta janela + coletor ligados, como o index.ts faz. */
function montar(dir: string, source: MessageInfoSource) {
  let collector: ReadReceiptsCollector | null = null;
  const window = new MessageWindow(200, 48 * 3600e3, (g, m, at, fromMe) => {
    if (fromMe) collector?.noteOwnMessage(g, m, at);
  });
  collector = new ReadReceiptsCollector(dir, () => source);
  return { window, collector };
}

async function run() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wa-reads-'));

  // ---------- RUN 1: mensagem minha, uma pessoa abre ----------
  {
    const emitted: Emitted[] = [];
    const source = new FakeSource(new Map([[MINHA, info([LIVIA])]]));
    const { window, collector } = montar(dir, source);

    window.track(G, MINHA, NOW - 60_000, true);
    await collector.start(makeCtx(dir, emitted));
    await collector.stop();

    assert.deepStrictEqual(
      emitted,
      [{ type: 'message_read', actorId: LIVIA, messageId: MINHA }],
      'a leitura deve sair uma vez',
    );
    ok('run 1: quem abriu a mensagem própria vira message_read');
  }

  // ---------- RUN 2: restart + backfill não pode reemitir ----------
  {
    const emitted: Emitted[] = [];
    const source = new FakeSource(new Map([[MINHA, info([LIVIA])]]));
    const { window, collector } = montar(dir, source);

    // O backfill retraz a mensagem; a MessageWindow nasce vazia a cada restart.
    window.track(G, MINHA, NOW - 60_000, true);
    await collector.start(makeCtx(dir, emitted));
    await collector.stop();

    assert.deepStrictEqual(emitted, [], `não pode reemitir; emitiu ${JSON.stringify(emitted)}`);
    ok('run 2: restart com backfill NÃO reemite leitura já registrada');
  }

  // ---------- RUN 3: leitor novo aparece, e o grupo termina de ler ----------
  {
    const emitted: Emitted[] = [];
    // readRemaining 0: todo mundo leu, a mensagem sai da vigilância.
    const source = new FakeSource(new Map([[MINHA, info([LIVIA, RAPHAEL, EU], 0)]]));
    const { window, collector } = montar(dir, source);

    window.track(G, MINHA, NOW - 60_000, true);
    await collector.start(makeCtx(dir, emitted));
    await collector.stop();

    assert.deepStrictEqual(
      emitted,
      [{ type: 'message_read', actorId: RAPHAEL, messageId: MINHA }],
      'só o leitor inédito sai — e a própria conta nunca',
    );
    ok('run 3: leitor novo é capturado; a leitura já conhecida e a própria conta ficam de fora');
  }

  // ---------- RUN 4: mensagem concluída não é mais consultada ----------
  {
    const emitted: Emitted[] = [];
    const source = new FakeSource(new Map([[MINHA, info([LIVIA, RAPHAEL], 0)]]));
    const { window, collector } = montar(dir, source);

    window.track(G, MINHA, NOW - 60_000, true);
    await collector.start(makeCtx(dir, emitted));
    await collector.stop();

    assert.deepStrictEqual(source.consultas, [], 'não pode gastar consulta com mensagem concluída');
    assert.deepStrictEqual(emitted, []);
    ok('run 4: mensagem que todo mundo leu sai da vigilância e não gasta mais consulta');
  }

  rmSync(dir, { recursive: true, force: true });

  // ---------- mensagem dos outros não é vigiada ----------
  {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'wa-reads-alheia-'));
    const emitted: Emitted[] = [];
    const ALHEIA = 'true_120363429416431036@g.us_3EB0OUTRA_livia';
    const source = new FakeSource(new Map([[ALHEIA, info([RAPHAEL])]]));
    const { window, collector } = montar(dir2, source);

    // fromMe: false — o WhatsApp não conta quem leu a mensagem de outra pessoa.
    window.track(G, ALHEIA, NOW - 60_000, false);
    await collector.start(makeCtx(dir2, emitted));
    await collector.stop();

    assert.deepStrictEqual(source.consultas, [], 'não faz sentido perguntar por mensagem alheia');
    assert.deepStrictEqual(emitted, []);
    ok('mensagem de terceiro nunca entra na vigilância de leitura');
    rmSync(dir2, { recursive: true, force: true });
  }

  // ---------- mesma pessoa em dois aparelhos conta uma leitura ----------
  {
    const dir3 = mkdtempSync(path.join(tmpdir(), 'wa-reads-devices-'));
    const emitted: Emitted[] = [];
    const source = new FakeSource(
      new Map([[MINHA, info(['5521994312345:12@c.us', '5521994312345@c.us'])]]),
    );
    const { window, collector } = montar(dir3, source);

    window.track(G, MINHA, NOW - 60_000, true);
    await collector.start(makeCtx(dir3, emitted));
    await collector.stop();

    assert.strictEqual(emitted.length, 1, 'celular e WhatsApp Web são a mesma leitura');
    assert.strictEqual(emitted[0]?.actorId, LIVIA, 'e o sufixo de dispositivo some do ator');
    ok('sufixo de dispositivo não duplica a leitura');
    rmSync(dir3, { recursive: true, force: true });
  }

  // ---------- normalizeParticipant ----------
  {
    assert.strictEqual(normalizeParticipant('199372465811459:71@lid'), '199372465811459@lid');
    assert.strictEqual(normalizeParticipant('5511988812345@c.us'), '5511988812345@c.us');
    assert.strictEqual(normalizeParticipant(''), '');
    ok('normalizeParticipant tira o sufixo de dispositivo de @lid e @c.us');
  }

  console.log(
    '\nSmoke test — confirmações de leitura\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`,
  );
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
