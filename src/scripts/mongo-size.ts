/**
 * Quanto do plano gratuito já foi usado, e quando ele estoura.
 *
 * Uso:
 *   npm run mongo:size
 *
 * O M0 do Atlas dá 512 MB contando **dados + índices**. As estimativas de custo
 * por mensagem feitas no papel valem como ordem de grandeza; este comando troca
 * a estimativa por medição: custo real por mensagem, ritmo dos últimos 7 dias e
 * a data projetada em que o teto é atingido.
 */

import { loadConfig } from '../config';
import { createLogger, setLogLevel } from '../util/logger';
import { MongoStore } from '../mongo/client';
import { COLLECTIONS } from '../mongo/schema';
import { dateKeyDaysAgo } from '../util/time';

const log = createLogger('mongo:size');

/** Teto do cluster gratuito M0. */
const FREE_TIER_BYTES = 512 * 1024 * 1024;

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (!config.mongo.uri) {
    log.error('MONGODB_URI não configurada — nada a medir.');
    process.exit(1);
  }

  const store = new MongoStore(config.mongo);
  const db = await store.connect();
  if (!db) {
    log.error('não foi possível conectar ao MongoDB');
    process.exit(1);
  }

  const rows: Array<{ nome: string; docs: number; dados: number; indices: number }> = [];

  for (const logical of Object.values(COLLECTIONS)) {
    const name = store.name(logical);
    try {
      const [stats] = await db
        .collection(name)
        .aggregate<{ count: number; storageSize: number; totalIndexSize: number }>([
          { $collStats: { storageStats: {} } },
          {
            $project: {
              count: '$storageStats.count',
              storageSize: '$storageStats.storageSize',
              totalIndexSize: '$storageStats.totalIndexSize',
            },
          },
        ])
        .toArray();
      if (!stats) continue;
      rows.push({
        nome: name,
        docs: stats.count ?? 0,
        dados: stats.storageSize ?? 0,
        indices: stats.totalIndexSize ?? 0,
      });
    } catch {
      // Coleção ainda não existe — sem dado, sem linha.
    }
  }

  const totalBytes = rows.reduce((sum, r) => sum + r.dados + r.indices, 0);
  const messages = rows.find((r) => r.nome === store.name(COLLECTIONS.messages))?.docs ?? 0;

  // Só estas crescem com o volume de conversa. `people` e `groups` são base
  // fixa: um grupo de 830 membros ocupa quase 1 MB antes da primeira mensagem,
  // e misturar isso no custo por mensagem daria um número sem sentido.
  const PROPORCIONAIS = new Set([
    store.name(COLLECTIONS.messages),
    store.name(COLLECTIONS.reactions),
    store.name(COLLECTIONS.activityDaily),
    store.name(COLLECTIONS.events),
  ]);
  const variavel = rows
    .filter((r) => PROPORCIONAIS.has(r.nome))
    .reduce((sum, r) => sum + r.dados + r.indices, 0);
  const base = totalBytes - variavel;

  // Abaixo disto o WiredTiger ainda está dominado pela alocação mínima de
  // extents e de índices, e a média por mensagem sai inflada em uma ordem de
  // grandeza. Melhor admitir que não dá para medir ainda.
  const AMOSTRA_MINIMA = 1_000;
  const amostraConfiavel = messages >= AMOSTRA_MINIMA;
  /** Estimativa de planejamento, usada enquanto não há amostra suficiente. */
  const ESTIMATIVA_POR_MENSAGEM = 1.25 * 1024;

  // --- ritmo recente, medido em activity_daily ---
  const since = dateKeyDaysAgo(7);
  const [pace] = await db
    .collection(store.name(COLLECTIONS.activityDaily))
    .aggregate<{ mensagens: number; dias: number }>([
      { $match: { personId: null, date: { $gte: since } } },
      {
        $group: {
          _id: null,
          mensagens: { $sum: { $ifNull: ['$messages', 0] } },
          dias: { $addToSet: '$date' },
        },
      },
      { $project: { mensagens: 1, dias: { $size: '$dias' } } },
    ])
    .toArray();

  const perDay = pace && pace.dias > 0 ? pace.mensagens / pace.dias : 0;
  const bytesPerMessage = amostraConfiavel
    ? variavel / messages
    : ESTIMATIVA_POR_MENSAGEM;
  const remaining = FREE_TIER_BYTES - totalBytes;

  const lines: string[] = [];
  lines.push('');
  lines.push('Uso do cluster (dados + índices contam para o limite de 512 MB)');
  lines.push('');
  lines.push(pad('coleção', 26) + pad('docs', 10) + pad('dados', 12) + pad('índices', 12));
  lines.push('─'.repeat(60));
  for (const row of rows.sort((a, b) => b.dados + b.indices - (a.dados + a.indices))) {
    lines.push(
      pad(row.nome, 26) +
        pad(row.docs.toLocaleString('pt-BR'), 10) +
        pad(mb(row.dados), 12) +
        pad(mb(row.indices), 12),
    );
  }
  lines.push('─'.repeat(60));
  lines.push(
    pad('TOTAL', 26) +
      pad('', 10) +
      pad(mb(totalBytes), 12) +
      `${((totalBytes / FREE_TIER_BYTES) * 100).toFixed(1)}% de 512 MB`,
  );
  lines.push('');

  lines.push(
    `Base fixa (people + groups): ${mb(base)} — cresce com o número de membros,` +
      ' não com a conversa',
  );
  if (amostraConfiavel) {
    lines.push(
      `Custo medido por mensagem: ${(bytesPerMessage / 1024).toFixed(2)} KB ` +
        '(mensagens, reações, série diária e log bruto, com índices)',
    );
  } else {
    lines.push(
      `Custo por mensagem: usando a estimativa de ${(ESTIMATIVA_POR_MENSAGEM / 1024).toFixed(2)} KB — ` +
        `com ${messages.toLocaleString('pt-BR')} mensagens a medição ainda não vale.`,
    );
    lines.push(
      `A partir de ~${AMOSTRA_MINIMA.toLocaleString('pt-BR')} mensagens o número passa a ser medido:` +
        ' abaixo disso, a alocação mínima do WiredTiger domina e infla a média.',
    );
  }

  if (perDay > 0 && bytesPerMessage > 0) {
    const daysLeft = Math.floor(remaining / (perDay * bytesPerMessage));
    const when = new Date(Date.now() + daysLeft * 86_400_000);
    lines.push('');
    lines.push(`Ritmo dos últimos 7 dias: ${Math.round(perDay).toLocaleString('pt-BR')} mensagens/dia`);
    lines.push(
      daysLeft > 3650
        ? 'Projeção: nesse ritmo, o limite não é atingido num horizonte relevante.'
        : `Projeção: o limite de 512 MB é atingido em ~${daysLeft} dias ` +
            `(${when.toLocaleDateString('pt-BR')}).`,
    );
    if (daysLeft < 60) {
      lines.push('');
      lines.push('Para ganhar fôlego sem trocar de plano:');
      lines.push('  MONGO_RAW_LOG=false          desliga o log bruto (~45% do espaço)');
      lines.push('  MONGO_RAW_LOG_TTL_DAYS=90    descarta o log com mais de 90 dias');
      lines.push('  O JSONL local continua sendo o registro permanente.');
    }
  } else {
    lines.push('');
    lines.push('Ainda não há dado suficiente para projetar o consumo.');
  }
  lines.push('');

  process.stdout.write(lines.join('\n'));
  await store.close();
}

function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width);
}

main().catch((error) => {
  log.error('falha ao medir', error);
  process.exit(1);
});
