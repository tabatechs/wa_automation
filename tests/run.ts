/**
 * Runner mínimo: executa cada *.test.ts em um processo próprio.
 *
 * Sem framework de propósito — os testes usam só node:assert e não precisam de
 * sessão do WhatsApp, então rodam em segundos e sem rede.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const dir = __dirname;
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

let failed = 0;
for (const file of files) {
  process.stdout.write(`\n──────── ${file} ────────\n`);
  const result = spawnSync(
    process.execPath,
    [path.join(dir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(dir, file)],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) failed += 1;
}

process.stdout.write(
  failed === 0
    ? `\n✅ ${files.length} arquivo(s) de teste OK\n`
    : `\n❌ ${failed} de ${files.length} arquivo(s) falharam\n`,
);
process.exit(failed === 0 ? 0 : 1);
