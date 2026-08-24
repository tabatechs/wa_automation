/*
 * O que conta como fala.
 *
 * `onAnyMessage` entrega também os avisos de sistema do WhatsApp. O maior deles
 * é o `gp2` — o balão cinza de "Fulano adicionou Beltrano" —, que é a mesma
 * entrada/saída já registrada em `member_events`, vista pelo lado do chat. Sem
 * filtro, cada entrada de participante virava `messagesSent += 1` e uma pessoa
 * que nunca escreveu uma linha deixava de ser `lurker`. Em produção foram 12%
 * de `messages` e 37 das 119 pessoas "com mensagem".
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isSpeech, NON_SPEECH_TYPES } from '../src/util/messageTypes';
import { MessagesCollector } from '../src/collectors/messages';
import { BackfillCollector } from '../src/collectors/backfill';
import { MessageWindow } from '../src/collectors/messageWindow';
import { CheckpointStore } from '../src/state/checkpoint';
import type { CollectorContext } from '../src/collectors/Collector';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

const G = '120363000000000000@g.us';
const DAY = 24 * 3600e3;

interface Emitida {
  messageId: string;
  messageType: string;
}

function harness(stateDir: string, store: unknown[] = []) {
  const emitidas: Emitida[] = [];
  let onAnyMessage: ((m: unknown) => Promise<void>) | null = null;

  const ctx = {
    client: {
      onAnyMessage: async (cb: (m: unknown) => Promise<void>) => {
        onAnyMessage = cb;
      },
      getAllMessagesInChat: async () => store.slice(),
    },
    config: {
      groups: [{ id: G }],
      backfillEnabled: true,
      backfillDays: 7,
      backfillMaxMessages: 5000,
      reactionWindowMs: 7 * DAY,
    },
    roster: {
      resolve: async (id: string | null) => ({ id, phone: null, name: null, nameSource: null }),
      resolveSelf: async () => null,
      resolveMany: async () => [],
      groupMembers: async () => [],
    },
    checkpoint: new CheckpointStore(stateDir),
    isMonitored: (id: unknown): id is string => id === G,
    groupName: async () => 'Grupo de exemplo',
    emit: async (e: { type: string; payload: Emitida }) => {
      if (e.type === 'message') emitidas.push(e.payload);
    },
    newEventId: () => 'id',
  } as unknown as CollectorContext;

  return { ctx, emitidas, entregar: (m: unknown) => onAnyMessage!(m) };
}

/** O objeto que o WA Web entrega para um aviso de sistema: sem corpo. */
const gp2 = (id: string, at: number) => ({
  id,
  timestamp: Math.floor(at / 1000),
  type: 'gp2',
  body: '',
  chatId: G,
  from: G,
  author: '146926720831515@lid',
});

const chat = (id: string, at: number) => ({
  id,
  timestamp: Math.floor(at / 1000),
  type: 'chat',
  body: 'olá pessoal',
  chatId: G,
  from: G,
  author: '146926720831515@lid',
});

async function run() {
  // --- a lista -------------------------------------------------------------
  {
    for (const tipo of ['gp2', 'ciphertext', 'revoked', 'e2e_notification', 'protocol']) {
      assert.strictEqual(isSpeech(tipo), false, `${tipo} não é fala`);
    }
    for (const tipo of ['chat', 'image', 'ptt', 'video', 'sticker', 'poll_creation']) {
      assert.strictEqual(isSpeech(tipo), true, `${tipo} é fala`);
    }
    ok('separa notificação de sistema de mensagem de verdade');

    // `groups_v4_invite` é um cartão que alguém mandou de propósito, e
    // `unknown` é o nosso próprio fallback para `type` ausente — pode ser uma
    // mensagem real. Nenhum dos dois pode entrar no corte por descuido.
    assert.strictEqual(isSpeech('groups_v4_invite'), true);
    assert.strictEqual(isSpeech('unknown'), true);
    assert.strictEqual(isSpeech(undefined), true, 'sem tipo, assume fala');
    assert.strictEqual(isSpeech(null), true);
    ok('na dúvida conta como fala — perder mensagem é pior que contar ruído');

    assert.strictEqual(isSpeech('GP2'), false, 'o tipo vem do WA Web; não confie no caixa');
    ok('comparação é insensível a caixa e espaço');

    assert.ok(NON_SPEECH_TYPES.has('gp2'));
  }

  // --- caminho ao vivo -----------------------------------------------------
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'wa-mt-'));
    const h = harness(dir);
    const janela = new MessageWindow(2000, 7 * DAY);
    await new MessagesCollector(janela).start(h.ctx);

    await h.entregar(gp2('gp2-1', Date.now()));
    assert.deepStrictEqual(h.emitidas, [], 'aviso de sistema não vira evento de mensagem');
    ok('onAnyMessage descarta gp2');

    assert.strictEqual(
      janela.size(G),
      0,
      'gp2 não recebe reação nem confirmação de leitura; vigiá-lo é consulta gasta',
    );
    ok('gp2 não entra na janela de reações');

    await h.entregar(chat('m1', Date.now()));
    assert.deepStrictEqual(
      h.emitidas.map((e) => e.messageId),
      ['m1'],
      'mensagem de verdade continua passando',
    );
    ok('mensagem normal segue seu caminho');
    rmSync(dir, { recursive: true, force: true });
  }

  // --- backfill ------------------------------------------------------------
  {
    // Com timestamp válido, de propósito: o teste antigo derrubava o gp2 por
    // não ter horário, o que escondia a ausência do filtro por tipo.
    const agora = Date.now();
    const historico = [chat('m1', agora - DAY), gp2('gp2-1', agora - 2 * 3600e3)];

    const dir = mkdtempSync(path.join(tmpdir(), 'wa-mt-'));
    const h = harness(dir, historico);
    const janela = new MessageWindow(2000, 7 * DAY);
    await new BackfillCollector(janela).start(h.ctx);

    assert.deepStrictEqual(
      h.emitidas.map((e) => e.messageId),
      ['m1'],
      `o gp2 do histórico não pode virar mensagem; veio ${JSON.stringify(h.emitidas)}`,
    );
    ok('backfill descarta gp2 mesmo com horário válido');

    assert.strictEqual(janela.size(G), 1, 'só a mensagem de verdade é vigiada');
    ok('backfill não põe gp2 na janela');
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nmessageTypes\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
