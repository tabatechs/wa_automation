/**
 * Reconstrói `group_roster_daily` — a lista oficial de cada grupo em cada dia —
 * a partir dos `group_snapshot` de boot gravados no JSONL.
 *
 * Uso:
 *   npm run mongo:roster-backfill -- <arquivo> [<arquivo> ...] [--desde AAAA-MM-DD] [--apply]
 *
 * Aceita `.jsonl` e `.jsonl.gz`, em qualquer ordem: a escolha do boot é pelo
 * horário, não pela ordem dos arquivos. Passe também os rotacionados
 * (`events-<data>.jsonl`) — `JsonlSink.rotate` renomeia, não apaga.
 *
 * Roda em seco por padrão: lê o que já está no banco e mostra o que faria.
 * `--apply` grava. Rodar de novo não muda nada (ver `decideRosterWrite`).
 *
 * `--desde` é 17/09/2026 por padrão. Antes de 16/09 os grupos fora da memória
 * do WA Web saíam com lista vazia no boot, e o próprio 16/09 teve 149 dos 161
 * grupos vazios: a série começaria com uma fração dos grupos e daria um salto
 * que parece crescimento.
 *
 * Os ids são traduzidos para o `_id` atual de `people` (ver
 * `canonicalResolver`).
 *
 * Não filtra pela whitelist do `.env` de quem roda. O JSONL só tem grupo que
 * estava na whitelist quando foi capturado — o snapshot de boot sai de
 * `config.groups`, e todo handler começa por `ctx.isMonitored` — então o
 * arquivo já é a whitelist de cada dia. Filtrar pelo `.env` local cortaria a
 * série inteira quando ele não é o da VM, e apagaria da história um grupo que
 * saiu da whitelist depois.
 *
 * O conteúdo dos arquivos não é logado: são telefones e nomes.
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import { MongoClient, type AnyBulkWriteOperation } from 'mongodb';

import { loadConfig } from '../config';
import { COLLECTIONS, INDEXES, type GroupRosterDailyDoc } from '../mongo/schema';
import {
  canonicalResolver,
  decideRosterWrite,
  earliest,
  rosterFromSnapshot,
  type PersonKeys,
  type RosterWrite,
} from '../mongo/rosterDaily';
import type { CapturedEvent } from '../types';
import { createLogger } from '../util/logger';

const log = createLogger('mongo:roster-backfill');

const DESDE_PADRAO = '2026-09-17';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--apply');
  const desdeIdx = args.indexOf('--desde');
  const desde = desdeIdx >= 0 ? args[desdeIdx + 1] : DESDE_PADRAO;
  if (!desde || !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    log.error('--desde espera AAAA-MM-DD');
    process.exit(1);
  }
  const arquivos = args
    .filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--desde')
    .map((a) => path.resolve(a));
  if (arquivos.length === 0) {
    log.error('passe o(s) arquivo(s) de eventos: .jsonl ou .jsonl.gz');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.mongo.uri) {
    log.error('sem MONGODB_URI no .env');
    process.exit(1);
  }

  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  try {
    const db = client.db(config.mongo.db);
    const sufixo = config.mongo.collectionSuffix;
    const nomeRoster = `${COLLECTIONS.groupRosterDaily}${sufixo}`;
    const roster = db.collection<GroupRosterDailyDoc>(nomeRoster);

    // Registro de planilha também entra: se um participante tiver o mesmo
    // número de um registro externo, é aquele documento que o caminho quente
    // vai adotar, e é esse `_id` que a lista precisa ter.
    const pessoas = await db
      .collection<PersonKeys>(`${COLLECTIONS.people}${sufixo}`)
      .find({}, { projection: { _id: 1, aliases: 1, mergedFrom: 1 } })
      .toArray();
    const resolve = canonicalResolver(pessoas);
    log.info('identidades carregadas', { pessoas: pessoas.length });

    const candidatas = new Map<string, GroupRosterDailyDoc>();
    const leitura = { linhas: 0, invalidas: 0, boots: 0, antesDoCorte: 0, vazios: 0 };

    for (const arquivo of arquivos) {
      log.info('lendo', { arquivo: path.basename(arquivo) });
      for await (const event of lerSnapshots(arquivo, leitura)) {
        if (event.type !== 'group_snapshot' || event.payload.reason !== 'boot') continue;
        leitura.boots += 1;
        const candidata = rosterFromSnapshot(event, resolve);
        if (!candidata) {
          leitura.vazios += 1;
          continue;
        }
        if (candidata.date < desde) {
          leitura.antesDoCorte += 1;
          continue;
        }
        const atual = candidatas.get(candidata._id);
        candidatas.set(candidata._id, atual ? earliest(atual, candidata) : candidata);
      }
    }
    log.info('leitura concluída', leitura);

    const existentes = new Map<string, GroupRosterDailyDoc>();
    const ids = [...candidatas.keys()];
    for (let i = 0; i < ids.length; i += 1000) {
      const lote = await roster.find({ _id: { $in: ids.slice(i, i + 1000) } }).toArray();
      for (const doc of lote) existentes.set(doc._id, doc);
    }

    const decisoes: Record<RosterWrite, number> = { insert: 0, replace: 0, repoint: 0, keep: 0 };
    const ops: AnyBulkWriteOperation<GroupRosterDailyDoc>[] = [];
    for (const candidata of candidatas.values()) {
      const existente = existentes.get(candidata._id) ?? null;
      const decisao = decideRosterWrite(existente, candidata);
      decisoes[decisao] += 1;
      if (decisao === 'keep') continue;
      const { _id, ...doc } = candidata;
      // O filtro repete o `capturedAt` lido: se o monitor gravou algo entre a
      // leitura e a escrita, a operação não casa e nada é sobrescrito às cegas.
      const filtro = existente ? { _id, capturedAt: existente.capturedAt } : { _id };
      ops.push({
        updateOne: existente
          ? { filter: filtro, update: { $set: doc } }
          : { filter: filtro, update: { $setOnInsert: doc }, upsert: true },
      } as AnyBulkWriteOperation<GroupRosterDailyDoc>);
    }

    resumoPorDia(candidatas);
    log.info('decisões', { colecao: nomeRoster, ...decisoes });

    if (!aplicar) {
      log.info('modo seco: nada foi gravado. Rode de novo com --apply para gravar.');
      return;
    }
    if (ops.length === 0) {
      log.info('nada a gravar');
      return;
    }

    const indices = INDEXES[COLLECTIONS.groupRosterDaily];
    if (indices.length) await roster.createIndexes([...indices]);
    for (let i = 0; i < ops.length; i += 500) {
      await roster.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    log.info('gravado', { operacoes: ops.length });
  } finally {
    await client.close();
  }
}

/**
 * Só os snapshots. O filtro por substring antes do `JSON.parse` poupa o parse
 * das mensagens, que são a maior parte de um `events.jsonl` completo.
 */
async function* lerSnapshots(
  arquivo: string,
  leitura: { linhas: number; invalidas: number },
): AsyncGenerator<CapturedEvent> {
  const bruto = createReadStream(arquivo);
  const input = arquivo.endsWith('.gz') ? bruto.pipe(createGunzip()) : bruto;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const linha of rl) {
    if (!linha.includes('group_snapshot')) continue;
    leitura.linhas += 1;
    try {
      yield JSON.parse(linha) as CapturedEvent;
    } catch {
      // Só a última linha de um arquivo pode estar truncada.
      leitura.invalidas += 1;
    }
  }
}

/**
 * Por dia: grupos com lista, pessoas distintas e saídas em relação ao último
 * dia anterior que o grupo tiver — o mesmo número que o painel vai mostrar,
 * para conferir antes de gravar. Só contagens, nenhum id.
 */
function resumoPorDia(candidatas: Map<string, GroupRosterDailyDoc>): void {
  const porDia = new Map<string, GroupRosterDailyDoc[]>();
  for (const linha of candidatas.values()) {
    const lista = porDia.get(linha.date) ?? [];
    lista.push(linha);
    porDia.set(linha.date, lista);
  }

  const ultimaPorGrupo = new Map<string, Set<string>>();
  for (const date of [...porDia.keys()].sort()) {
    const linhas = porDia.get(date) ?? [];
    const pessoas = new Set<string>();
    const saidas = new Set<string>();
    let saidasPorGrupo = 0;
    for (const linha of linhas) {
      const hoje = new Set(linha.members);
      for (const p of hoje) pessoas.add(p);
      const anterior = ultimaPorGrupo.get(linha.groupId);
      if (anterior) {
        for (const p of anterior) {
          if (!hoje.has(p)) {
            saidas.add(p);
            saidasPorGrupo += 1;
          }
        }
      }
      ultimaPorGrupo.set(linha.groupId, hoje);
    }
    log.info('dia', {
      date,
      grupos: linhas.length,
      pessoasDistintas: pessoas.size,
      saidasPessoaGrupo: saidasPorGrupo,
      saidasPessoasDistintas: saidas.size,
    });
  }
}

main().catch((error) => {
  log.error('falha na reconstrução', error);
  process.exit(1);
});
