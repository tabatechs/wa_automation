/**
 * Recalcula as métricas derivadas de `people` e `groups`.
 *
 * Uso:
 *   npm run mongo:build            -> taxas, rankings, tendências, scores
 *   npm run mongo:build -- --full  -> recontagem completa, inclusive dos brutos
 *
 * O monitor já roda a versão normal sozinho a cada METRICS_REFRESH_MS. Este
 * comando existe para rodar sob demanda e, com `--full`, para consertar
 * qualquer deriva: ele reconta tudo a partir de `messages`/`reactions`, que são
 * a fonte da verdade.
 */

import { loadConfig } from '../config';
import { createLogger, setLogLevel } from '../util/logger';
import { MongoStore } from '../mongo/client';
import { MetricsBuilder } from '../mongo/metrics';

const log = createLogger('mongo:build');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (!config.mongo.uri) {
    log.error('MONGODB_URI não configurada — nada a fazer. Preencha o .env.');
    process.exit(1);
  }

  const full = process.argv.slice(2).includes('--full');
  const store = new MongoStore(config.mongo);

  if (!(await store.connect())) {
    log.error('não foi possível conectar ao MongoDB');
    process.exit(1);
  }

  const stats = await new MetricsBuilder(store).refresh({ full });
  await store.close();

  process.stdout.write(
    `\n${full ? 'Recontagem completa' : 'Recálculo'}: ` +
      `${stats.people} pessoa(s), ${stats.groups} grupo(s), ` +
      `${stats.merged} fusão(ões) de identidade, ${stats.durationMs} ms\n`,
  );
}

main().catch((error) => {
  log.error('falha no recálculo', error);
  process.exit(1);
});
