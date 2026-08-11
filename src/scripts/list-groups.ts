/**
 * Lista todos os grupos da conta conectada, para você escolher quais monitorar.
 *
 * Uso:
 *   npm run list-groups
 *
 * Os dados vão para stdout (log fica em stderr), então dá para redirecionar:
 *   npm run list-groups > grupos.txt
 *
 * Copie o `id` desejado para config/groups.json e marque "enabled": true.
 */

import { loadConfig } from '../config';
import { startSession, stopSession } from '../session';
import { createLogger, setLogLevel } from '../util/logger';

const log = createLogger('list-groups');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const client = await startSession(config);
  try {
    const groups = await client.getAllGroups();
    if (!groups || groups.length === 0) {
      log.warn('nenhum grupo encontrado nesta conta');
      return;
    }

    process.stdout.write(`\nGrupos encontrados: ${groups.length}\n\n`);
    for (const group of groups) {
      const id = String((group as { id?: unknown }).id ?? '');
      const name =
        (group as { name?: string }).name ??
        (group as { formattedTitle?: string }).formattedTitle ??
        '(sem nome)';
      process.stdout.write(`  ${name}\n    id: ${id}\n\n`);
    }

    process.stdout.write(
      'Cole o id escolhido em config/groups.json:\n\n' +
        '  { "groups": [ { "id": "COLE_AQUI@g.us", "label": "Meu grupo", "enabled": true } ] }\n\n',
    );
  } finally {
    await stopSession(client);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error('falha ao listar grupos', error);
    process.exit(1);
  });
