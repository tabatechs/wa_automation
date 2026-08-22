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
import { MongoSink } from './sink/MongoSink';
import { MultiSink } from './sink/MultiSink';
import type { Sink } from './sink/Sink';
import { MetricsScheduler } from './mongo/scheduler';
import { MessageWindow } from './collectors/messageWindow';
import { MessagesCollector } from './collectors/messages';
import { ParticipantsCollector } from './collectors/participants';
import { ReactionsCollector } from './collectors/reactions';
import { ReadReceiptsCollector } from './collectors/readReceipts';
import { BackfillCollector } from './collectors/backfill';
import { patchMessageSerializer } from './util/page';
import { CheckpointStore } from './state/checkpoint';
import { emitGroupSnapshot } from './collectors/groupSnapshot';
import type { Collector, CollectorContext } from './collectors/Collector';
import { EVENT_SCHEMA_VERSION, type CapturedEvent } from './types';
import { createLogger, setLogLevel } from './util/logger';
import { localIso } from './util/time';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (config.groups.length === 0) {
    log.warn(
      'MONITORED_GROUPS está vazio no .env — nada será gravado. ' +
        'Rode `npm run list-groups` para descobrir os ids.',
    );
  } else {
    log.info('grupos monitorados', config.groups.map((g) => g.id));
  }

  // O JSONL é sempre o destino durável; o Mongo entra ao lado quando há URI.
  // Se o banco cair, o arquivo continua completo e `mongo:import` recupera.
  const jsonl = new JsonlSink({
    filePath: config.eventsFile,
    maxBytes: config.eventsMaxBytes,
  });
  const mongoSink = config.mongo.uri ? new MongoSink(config.mongo) : null;
  const sink: Sink = mongoSink ? new MultiSink([jsonl, mongoSink]) : jsonl;
  if (mongoSink) {
    log.info('MongoDB habilitado', {
      db: config.mongo.db,
      sufixo: config.mongo.collectionSuffix || '(produção)',
      logBruto: config.mongo.rawLog,
    });
  }

  // Métricas caras (percentis, concentração, tendências) fora do caminho quente.
  const metrics = new MetricsScheduler(config.mongo);

  // A janela avisa o coletor de reações sobre cada mensagem nova, e o coletor lê
  // a janela a cada varredura. A referência diferida quebra esse ciclo sem
  // precisar mexer na visibilidade dos campos.
  let reactions: ReactionsCollector | null = null;
  let reads: ReadReceiptsCollector | null = null;
  const window = new MessageWindow(
    config.reactionWindowSize,
    config.reactionWindowMs,
    (groupId, messageId, at, fromMe) => {
      reactions?.noteLiveMessage(groupId, messageId, at);
      // Só mensagem própria tem confirmação de leitura — o WhatsApp não conta
      // quem leu a mensagem dos outros.
      if (fromMe) reads?.noteOwnMessage(groupId, messageId, at);
    },
  );
  const reactionsCollector = new ReactionsCollector(window, config.stateDir);
  reactions = reactionsCollector;
  const readReceiptsCollector = new ReadReceiptsCollector(config.stateDir);
  reads = readReceiptsCollector;

  const checkpoint = new CheckpointStore(config.stateDir);

  // A ordem importa. Os listeners ao vivo entram primeiro para não perder nada
  // que chegue durante o backfill; a sobreposição entre os dois é resolvida
  // pelo dedupe por messageId no checkpoint. O backfill vem antes do coletor de
  // reações para que a janela já esteja povoada na primeira varredura.
  const collectors: Collector[] = [
    new MessagesCollector(window),
    new ParticipantsCollector(),
    new BackfillCollector(window),
    reactionsCollector,
    // Depois do backfill: as mensagens próprias do histórico recente já entraram
    // na janela e são vigiadas desde a primeira varredura.
    readReceiptsCollector,
  ];

  let shuttingDown = false;

  const wire = async (client: Client): Promise<void> => {
    // Antes de qualquer coletor: sem o remendo, `getAllMessagesInChat` morre
    // inteiro na primeira mensagem que cita outra, e o backfill e as reações
    // não devolvem nada. Ver `patchMessageSerializer` em util/page.ts.
    await patchMessageSerializer(safePage(client));

    const ctx = buildContext(client, config, sink, checkpoint);
    // Descobre o número da própria conta antes de qualquer coletor, senão as
    // mensagens enviadas por você sairiam sem autor.
    await ctx.roster.loadHostIdentity();
    await registerStateListener(ctx);
    for (const group of config.groups) {
      await emitGroupSnapshot(ctx, group.id, 'boot');
    }
    for (const collector of collectors) {
      await collector.start(ctx);
    }
    checkpoint.save();
  };

  const client = await startSession(config, async (restarted) => {
    // Sessão recriada após crash: o Client anterior morreu com seus listeners.
    await wire(restarted);
  });

  await wire(client);
  metrics.start();
  log.info('monitor ativo — Ctrl+C para encerrar');

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`recebido ${signal}, encerrando`);
    for (const collector of collectors) {
      await collector.stop().catch((e) => log.warn(`falha ao parar ${collector.name}`, e));
    }
    // Persiste o ponto de retomada antes de sair: é o que permite a próxima
    // execução capturar só o que aconteceu no intervalo.
    checkpoint.save();
    await stopSession(client);
    await metrics.stop();
    // Fecha o sink por último: é ele que drena o que ainda está em buffer.
    await sink.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function buildContext(
  client: Client,
  config: AppConfig,
  sink: Sink,
  checkpoint: CheckpointStore,
): CollectorContext {
  const roster = new Roster(client, config.rosterTtlMs);
  const nameCache = new Map<string, string | null>();

  return {
    client,
    config,
    roster,
    sink,
    checkpoint,
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
        // Sem nome: a whitelist guarda só ids, e inventar um apelido local
        // criaria um segundo nome para o mesmo grupo. O recálculo preenche o
        // nome a partir do group_snapshot, que vem do WhatsApp.
        name = null;
      }
      nameCache.set(groupId, name);
      return name;
    },
    emit: (event) => sink.write(event),
    newEventId: randomUUID,
  };
}

/**
 * A página do puppeteer, ou null. `getPage()` lança quando a sessão ainda não
 * terminou de subir, e isso não pode custar o boot.
 */
function safePage(client: Client): unknown {
  try {
    return client.getPage();
  } catch {
    return null;
  }
}

/** Registra transições de estado da sessão (CONNECTED, DISCONNECTED, ...). */
async function registerStateListener(ctx: CollectorContext): Promise<void> {
  let previous: string | null = null;
  await ctx.client.onStateChanged(async (state: string) => {
    const event: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type: 'session_state',
      capturedAt: localIso(),
      group: null,
      actor: null,
      payload: { state, previous },
    };
    previous = state;
    log.info('estado da sessão', { state });

    // Uma reconexão recarrega a página e o WA Web reinjeta o WAPI original —
    // o remendo do serializador se perderia em silêncio, e o backfill voltaria
    // a morrer na primeira mensagem citada. Reaplicar é barato: o próprio
    // código injetado desiste com 'ja-aplicado' quando ainda está no lugar.
    if (state === 'CONNECTED') {
      await patchMessageSerializer(safePage(ctx.client));
    }

    await ctx.emit(event);
  });
}

main().catch((error) => {
  log.error('falha fatal', error);
  process.exit(1);
});
