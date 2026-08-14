/**
 * Importa data/events.jsonl (e os arquivos rotacionados) para o MongoDB.
 *
 * Uso:
 *   npm run mongo:import                  -> lê o arquivo de eventos e os rotacionados
 *   npm run mongo:import -- caminho.jsonl -> lê um arquivo específico
 *   npm run mongo:import -- --only-current -> ignora os rotacionados
 *
 * É seguro rodar quantas vezes quiser: todo `_id` é derivado do conteúdo, então
 * reimportar não duplica documento nem incrementa contador. É também o caminho
 * de recuperação quando o Mongo esteve fora do ar — o JSONL continuou completo.
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { loadConfig } from '../config';
import { createLogger, setLogLevel } from '../util/logger';
import { MongoStore } from '../mongo/client';
import { Ingestor } from '../mongo/ingest';
import { MetricsBuilder } from '../mongo/metrics';
import type { CapturedEvent } from '../types';

const log = createLogger('mongo:import');

/** Lotes grandes: o gargalo é a latência até o Atlas, não a CPU. */
const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (!config.mongo.uri) {
    log.error('MONGODB_URI não configurada — nada a fazer. Preencha o .env.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const onlyCurrent = args.includes('--only-current');
  const explicit = args.find((a) => !a.startsWith('--'));
  const files = explicit ? [path.resolve(explicit)] : discoverFiles(config.eventsFile, onlyCurrent);

  if (files.length === 0) {
    log.error('nenhum arquivo de eventos encontrado', { esperado: config.eventsFile });
    process.exit(1);
  }

  const store = new MongoStore(config.mongo);
  if (!(await store.connect())) {
    log.error('não foi possível conectar ao MongoDB');
    process.exit(1);
  }

  const ingestor = new Ingestor(store, config.mongo.rawLog);
  const totals = { lidas: 0, invalidas: 0, mensagens: 0, reacoes: 0, leituras: 0, membros: 0, snapshots: 0 };

  for (const file of files) {
    log.info('importando', { arquivo: path.basename(file) });
    let batch: CapturedEvent[] = [];

    const rl = readline.createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: CapturedEvent;
      try {
        event = JSON.parse(trimmed) as CapturedEvent;
      } catch {
        // Só a última linha pode estar truncada, se o processo morreu escrevendo.
        totals.invalidas += 1;
        continue;
      }

      totals.lidas += 1;
      batch.push(event);

      if (batch.length >= BATCH_SIZE) {
        await drain(ingestor, batch, totals);
        batch = [];
      }
    }

    if (batch.length) await drain(ingestor, batch, totals);
  }

  log.info('importação concluída', totals);

  // Sem esta passada, `people` e `groups` ficariam só com os contadores brutos
  // e nenhuma taxa, score ou tendência.
  log.info('recalculando métricas derivadas');
  await new MetricsBuilder(store).refresh({ full: true });

  await store.close();
}

async function drain(
  ingestor: Ingestor,
  batch: CapturedEvent[],
  totals: { mensagens: number; reacoes: number; leituras: number; membros: number; snapshots: number },
): Promise<void> {
  const stats = await ingestor.apply(batch);
  totals.mensagens += stats.messages;
  totals.reacoes += stats.reactions;
  totals.leituras += stats.reads;
  totals.membros += stats.memberEvents;
  totals.snapshots += stats.snapshots;
  process.stdout.write('.');
}

/**
 * O `JsonlSink` rotaciona por tamanho, gerando `events-<data>.jsonl` ao lado do
 * arquivo corrente. Uma importação que só olhasse o arquivo atual perderia todo
 * o histórico anterior à última rotação.
 */
function discoverFiles(eventsFile: string, onlyCurrent: boolean): string[] {
  const dir = path.dirname(eventsFile);
  const base = path.basename(eventsFile, path.extname(eventsFile));
  const files: string[] = [];

  if (!onlyCurrent && existsSync(dir)) {
    const rotated = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.jsonl'))
      .sort() // o carimbo de data no nome já ordena cronologicamente
      .map((f) => path.join(dir, f));
    files.push(...rotated);
  }

  if (existsSync(eventsFile)) files.push(eventsFile);
  return files;
}

main().catch((error) => {
  log.error('falha na importação', error);
  process.exit(1);
});
