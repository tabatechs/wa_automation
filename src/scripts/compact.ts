/**
 * Converte data/events.jsonl (uma linha por evento) num array JSON convencional.
 *
 * Uso:
 *   npm run compact                      -> data/events.json
 *   npm run compact -- caminho/saida.json
 *
 * O JSONL é o formato de gravação porque o append é atômico e sobrevive a
 * crashes; este script existe para quando você precisar de um .json único para
 * consumir em outra ferramenta.
 */

import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config';
import { createLogger } from '../util/logger';

const log = createLogger('compact');

async function main(): Promise<void> {
  const config = loadConfig();
  const input = config.eventsFile;

  if (!existsSync(input)) {
    log.error(`arquivo de eventos não encontrado: ${input}`);
    process.exit(1);
  }

  const output =
    process.argv[2] ??
    path.join(path.dirname(input), `${path.basename(input, path.extname(input))}.json`);

  const events: unknown[] = [];
  let skipped = 0;

  const rl = readline.createInterface({
    input: createReadStream(input, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Só a última linha pode estar truncada, se o processo morreu escrevendo.
      skipped += 1;
    }
  }

  writeFileSync(output, `${JSON.stringify(events, null, 2)}\n`, 'utf8');
  log.info('arquivo gerado', { output, eventos: events.length, linhasIgnoradas: skipped });
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  log.error('falha ao compactar', error);
  process.exit(1);
});
