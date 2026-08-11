/**
 * Entrypoint do monitor.
 *
 * Sobe a sessão do WhatsApp, registra os coletores e grava tudo em JSONL local.
 * Somente leitura: nada é enviado a nenhum grupo.
 */

import { randomUUID } from 'node:crypto';
import type { Client } from '@open-wa/wa-automate';
import { loadConfig, type AppConfig } from './config';
import { startSession, stopSession } from './session';
import { Roster } from './enrich/roster';
import { JsonlSink } from './sink/JsonlSink';
import type { Sink } from './sink/Sink';
import { MessageWindow } from './collectors/messageWindow';
import { MessagesCollector } from './collectors/messages';
import { ParticipantsCollector } from './collectors/participants';
import { ReactionsCollector } from './collectors/reactions';
import { emitGroupSnapshot } from './collectors/groupSnapshot';
import type { Collector, CollectorContext } from './collectors/Collector';
import { EVENT_SCHEMA_VERSION, type CapturedEvent } from './types';
import { createLogger, setLogLevel } from './util/logger';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (config.groups.length === 0) {
    log.warn(
      'Nenhum grupo habilitado em config/groups.json — nada será gravado. ' +
        'Rode `npm run list-groups` para descobrir os ids.',
    );
  } else {
    log.info('grupos monitorados', config.groups.map((g) => g.label ?? g.id));
  }

  const sink: Sink = new JsonlSink({
    filePath: config.eventsFile,
    maxBytes: config.eventsMaxBytes,
  });

  // A janela avisa o coletor de reações sobre cada mensagem nova, e o coletor lê
  // a janela a cada varredura. A referência diferida quebra esse ciclo sem
  // precisar mexer na visibilidade dos campos.
  let reactions: ReactionsCollector | null = null;
  const window = new MessageWindow(
    config.reactionWindowSize,
    config.reactionWindowMs,
    (groupId, messageId) => reactions?.noteLiveMessage(groupId, messageId),
  );
  const reactionsCollector = new ReactionsCollector(window, config.stateDir);
  reactions = reactionsCollector;

  const collectors: Collector[] = [
    new MessagesCollector(window),
    new ParticipantsCollector(),
    reactionsCollector,
  ];

  let shuttingDown = false;

  const wire = async (client: Client): Promise<void> => {
    const ctx = buildContext(client, config, sink);
    for (const collector of collectors) {
      await collector.start(ctx);
    }
    await registerStateListener(ctx);
    for (const group of config.groups) {
      await emitGroupSnapshot(ctx, group.id, 'boot');
    }
  };

  const client = await startSession(config, async (restarted) => {
    // Sessão recriada após crash: o Client anterior morreu com seus listeners.
    await wire(restarted);
  });

  await wire(client);
  log.info('monitor ativo — Ctrl+C para encerrar');

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`recebido ${signal}, encerrando`);
    for (const collector of collectors) {
      await collector.stop().catch((e) => log.warn(`falha ao parar ${collector.name}`, e));
    }
    await stopSession(client);
    await sink.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function buildContext(client: Client, config: AppConfig, sink: Sink): CollectorContext {
  const roster = new Roster(client, config.rosterTtlMs);
  const nameCache = new Map<string, string | null>();

  return {
    client,
    config,
    roster,
    sink,
    isMonitored: (chatId): chatId is string =>
      typeof chatId === 'string' && config.groupIds.has(chatId),
    async groupName(groupId: string): Promise<string | null> {
      if (nameCache.has(groupId)) return nameCache.get(groupId) ?? null;
      let name: string | null = null;
      try {
        const chat = (await client.getChatById(
          groupId as Parameters<Client['getChatById']>[0],
        )) as { name?: string; formattedTitle?: string } | undefined;
        name = chat?.name ?? chat?.formattedTitle ?? null;
      } catch {
        name = config.groups.find((g) => g.id === groupId)?.label ?? null;
      }
      nameCache.set(groupId, name);
      return name;
    },
    emit: (event) => sink.write(event),
    newEventId: randomUUID,
  };
}

/** Registra transições de estado da sessão (CONNECTED, DISCONNECTED, ...). */
async function registerStateListener(ctx: CollectorContext): Promise<void> {
  let previous: string | null = null;
  await ctx.client.onStateChanged(async (state: string) => {
    const event: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type: 'session_state',
      capturedAt: new Date().toISOString(),
      group: null,
      actor: null,
      payload: { state, previous },
    };
    previous = state;
    log.info('estado da sessão', { state });
    await ctx.emit(event);
  });
}

main().catch((error) => {
  log.error('falha fatal', error);
  process.exit(1);
});
