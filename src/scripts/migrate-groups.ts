/**
 * Migra grupos inteiros de um sufixo de coleção para outro — o caminho da
 * virada de `_teste` para produção.
 *
 * Uso:
 *   npm run mongo:migrate -- --to= 1203...@g.us 1203...@g.us
 *   npm run mongo:migrate -- --from=_teste --to=_prod --dry-run 1203...@g.us
 *
 * ## Por que replay de evento, e não cópia de documento
 *
 * `messages`, `reactions` e afins são por grupo e poderiam ser copiadas com um
 * `$match` no `groupId`. `people` não: uma pessoa é um documento só, somando
 * todos os grupos em que ela aparece. Copiá-la traria junto o que ela fez nos
 * grupos que ficam para trás, e não há como subtrair depois — `mentionsMade`,
 * `conversationsStarted`, `emojisUsed` e `firstSeenAt` não são recontados nem
 * pelo `--full`.
 *
 * Então o que se migra é o **evento**, não o resultado: os eventos dos grupos
 * escolhidos são remontados num JSONL e passados pelo `Ingestor` normal, como
 * se o monitor só tivesse visto esses grupos desde sempre. O destino sai
 * idêntico ao que uma captura limpa teria produzido, e o JSONL fica em disco
 * como o de sempre — reimportável, já que todo `_id` é derivado do conteúdo.
 *
 * ## O que precisa ser remontado
 *
 * O log bruto no Mongo (`events`) deixa `group_snapshot` e `message_read` de
 * fora por volume (ver `writeRawLog` em `ingest.ts`), então os dois são
 * reconstruídos a partir do estado que restou:
 *
 * - `message_read` sai de `message_reads`, que guarda tudo que o evento tinha.
 *   A chave do documento é `${targetMessageId}|${actorKey}`, e é dali que o id
 *   do WhatsApp do leitor volta — sem ele o `_id` no destino sairia diferente.
 * - `group_snapshot` sai de `people.groups[]`: a lista de participantes de um
 *   grupo é exatamente quem tem vínculo ativo com ele. É o único caminho, e é
 *   o que repõe `memberCount`, `participants[]` e `admins` no destino.
 *
 * O que não sobrevive à remontagem é o `capturedAt` original desses dois: o do
 * snapshot vira o primeiro evento conhecido do grupo (era o boot, na prática) e
 * o da leitura vira o próprio `readAt`. Nenhum dos dois entra em métrica — o
 * ingest usa `readAt` quando ele existe, e sempre existe aqui.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, PROJECT_ROOT, type MongoConfig } from '../config';
import { createLogger, setLogLevel } from '../util/logger';
import { MongoStore } from '../mongo/client';
import { Ingestor } from '../mongo/ingest';
import { MetricsBuilder } from '../mongo/metrics';
import {
  COLLECTIONS,
  type MessageReadDoc,
  type PersonDoc,
  type RawEventDoc,
} from '../mongo/schema';
import type {
  CapturedEvent,
  NameSource,
  ParticipantSnapshot,
} from '../types';
import { isGroupId } from '../util/phone';
import { localIso, localStamp } from '../util/time';

const log = createLogger('mongo:migrate');

/** Mesmo lote do `mongo:import`: o gargalo é a latência até o Atlas. */
const BATCH_SIZE = 500;

interface Options {
  from: string;
  to: string;
  groupIds: string[];
  dryRun: boolean;
  outFile: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (!config.mongo.uri) {
    log.error('MONGODB_URI não configurada — nada a migrar. Preencha o .env.');
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));

  log.info('migração', {
    de: options.from || '(nenhum)',
    para: options.to || '(nenhum)',
    grupos: options.groupIds.length,
    simulacao: options.dryRun,
  });

  const origem = new MongoStore(withSuffix(config.mongo, options.from));
  if (!(await origem.connect())) {
    log.error('não foi possível conectar ao MongoDB de origem');
    process.exit(1);
  }

  const eventos = await buildEvents(origem, options.groupIds);
  await origem.close();

  if (eventos.length === 0) {
    log.error('nenhum evento encontrado para os grupos informados', { grupos: options.groupIds });
    process.exit(1);
  }

  mkdirSync(path.dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, eventos.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  log.info('eventos remontados em disco', {
    arquivo: path.relative(PROJECT_ROOT, options.outFile),
    total: eventos.length,
    porTipo: countByType(eventos),
  });

  if (options.dryRun) {
    log.info('simulação: nada foi escrito no destino');
    return;
  }

  const destino = new MongoStore(withSuffix(config.mongo, options.to));
  if (!(await destino.connect())) {
    log.error('não foi possível conectar ao MongoDB de destino');
    process.exit(1);
  }

  const ingestor = new Ingestor(destino, config.mongo.rawLog);
  const totais = { mensagens: 0, reacoes: 0, leituras: 0, membros: 0, snapshots: 0 };

  for (let i = 0; i < eventos.length; i += BATCH_SIZE) {
    const stats = await ingestor.apply(eventos.slice(i, i + BATCH_SIZE));
    totais.mensagens += stats.messages;
    totais.reacoes += stats.reactions;
    totais.leituras += stats.reads;
    totais.membros += stats.memberEvents;
    totais.snapshots += stats.snapshots;
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  log.info('ingestão concluída', totais);

  // Sem esta passada `people` e `groups` ficam só com os contadores brutos:
  // nenhuma taxa, nenhum score, nenhum ranking, e `participants[]` vazio.
  log.info('recalculando métricas derivadas');
  await new MetricsBuilder(destino).refresh({ full: true });

  await destino.close();
  log.info('migração concluída');
}

// ---------------------------------------------------------------------------
// remontagem dos eventos
// ---------------------------------------------------------------------------

async function buildEvents(origem: MongoStore, groupIds: string[]): Promise<CapturedEvent[]> {
  const brutos = await readRawEvents(origem, groupIds);
  const pessoas = await readPeople(origem, groupIds);
  const leituras = await buildReadEvents(origem, groupIds, pessoas);
  const snapshots = buildSnapshotEvents(groupIds, pessoas, earliestByGroup(brutos));

  log.info('remontagem', {
    logBruto: brutos.length,
    leiturasReconstruidas: leituras.length,
    snapshotsReconstruidos: snapshots.length,
    pessoasEnvolvidas: pessoas.size,
  });

  const resto = [...brutos, ...leituras].sort(
    (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
  );

  // Snapshot primeiro, sempre: ele diz quem *está* no grupo hoje e marca todo
  // vínculo como ativo. Depois dele vêm as entradas e saídas, que são as
  // únicas que sabem a data do movimento — na ordem inversa, uma saída antiga
  // seria desfeita por um retrato do presente.
  return [...snapshots, ...resto];
}

async function readRawEvents(origem: MongoStore, groupIds: string[]): Promise<CapturedEvent[]> {
  const colecao = await origem.collection<RawEventDoc>(COLLECTIONS.events);
  if (!colecao) return [];

  const docs = await colecao
    .find({ groupId: { $in: groupIds } })
    .sort({ capturedAt: 1 })
    .toArray();

  const eventos: CapturedEvent[] = [];
  for (const doc of docs) {
    const evento = doc.event as CapturedEvent | undefined;
    // Um documento sem o evento embutido não tem como ser reprocessado; o
    // resto da migração vale mais que a linha perdida, então só avisa.
    if (!evento || !evento.type) {
      log.warn('evento bruto sem conteúdo, ignorado', { id: doc._id });
      continue;
    }
    eventos.push(evento);
  }
  return eventos;
}

/** Pessoas com qualquer vínculo (ativo ou não) com os grupos migrados. */
async function readPeople(
  origem: MongoStore,
  groupIds: string[],
): Promise<Map<string, PersonDoc>> {
  const colecao = await origem.collection<PersonDoc>(COLLECTIONS.people);
  if (!colecao) return new Map();

  const docs = await colecao.find({ 'groups.groupId': { $in: groupIds } }).toArray();
  return new Map(docs.map((doc) => [doc._id, doc]));
}

/**
 * Refaz os `message_read` a partir de `message_reads`. O ator é remontado com o
 * id do WhatsApp que está embutido na chave do documento — usar o `personId`
 * no lugar dele mudaria o `_id` no destino e a leitura viraria duas.
 */
async function buildReadEvents(
  origem: MongoStore,
  groupIds: string[],
  pessoas: Map<string, PersonDoc>,
): Promise<CapturedEvent[]> {
  const colecao = await origem.collection<MessageReadDoc>(COLLECTIONS.messageReads);
  if (!colecao) return [];

  const docs = await colecao.find({ groupId: { $in: groupIds } }).toArray();
  const eventos: CapturedEvent[] = [];

  for (const doc of docs) {
    const pessoa = pessoas.get(doc.personId);
    const actorId = actorKeyOf(doc) ?? (pessoa ? actorIdOf(pessoa) : null);
    if (!actorId) {
      log.warn('leitura sem id de ator, ignorada', { id: doc._id });
      continue;
    }

    const readAt = doc.readAt ? localIso(new Date(doc.readAt)) : null;
    eventos.push({
      schema: 1,
      eventId: randomUUID(),
      type: 'message_read',
      // O `capturedAt` original não sobreviveu ao log bruto. Nada em `ingest`
      // o consulta quando há `readAt`, que é o caso de toda leitura gravada.
      capturedAt: readAt ?? localIso(),
      group: { id: doc.groupId, name: null },
      actor: {
        id: actorId,
        phone: pessoa?.phone ?? null,
        name: pessoa?.name ?? null,
        nameSource: (pessoa?.nameSource ?? null) as NameSource,
      },
      payload: { targetMessageId: doc.targetMessageId, readAt, source: 'store-cache' },
    });
  }
  return eventos;
}

/**
 * Um `group_snapshot` por grupo, com o retrato atual do quadro de membros.
 *
 * É o que repõe `participants[]`, `memberCount` e `admins` no destino: o
 * recálculo monta os três a partir de `people.groups[]`, e sem snapshot só
 * entraria no vínculo quem falou ou reagiu.
 */
function buildSnapshotEvents(
  groupIds: string[],
  pessoas: Map<string, PersonDoc>,
  primeiroEvento: Map<string, string>,
): CapturedEvent[] {
  const eventos: CapturedEvent[] = [];

  for (const groupId of groupIds) {
    const participantes: ParticipantSnapshot[] = [];

    for (const pessoa of pessoas.values()) {
      const vinculo = (pessoa.groups ?? []).find((g) => g.groupId === groupId);
      if (!vinculo?.active) continue;
      const id = actorIdOf(pessoa);
      if (!id) continue;
      participantes.push({
        id,
        phone: pessoa.phone,
        name: pessoa.name,
        nameSource: (pessoa.nameSource ?? null) as NameSource,
        isAdmin: vinculo.isAdmin,
        isSuperAdmin: false,
      });
    }

    // Um snapshot vazio é descartado pelo ingest de qualquer forma, e emiti-lo
    // só esconderia que o grupo não tem quadro de membros na origem.
    if (participantes.length === 0) {
      log.warn('grupo sem participantes ativos na origem; snapshot não gerado', { groupId });
      continue;
    }

    eventos.push({
      schema: 1,
      eventId: randomUUID(),
      type: 'group_snapshot',
      capturedAt: primeiroEvento.get(groupId) ?? localIso(),
      group: { id: groupId, name: null },
      actor: null,
      payload: {
        subject: null,
        description: null,
        owner: null,
        participantCount: participantes.length,
        participants: participantes,
        reason: 'manual',
      },
    });
  }

  return eventos;
}

// ---------------------------------------------------------------------------
// auxiliares
// ---------------------------------------------------------------------------

/**
 * O id do WhatsApp do leitor, extraído da chave `${targetMessageId}|${actorKey}`.
 * É a única cópia que restou dele depois que o evento saiu do log bruto.
 */
function actorKeyOf(doc: MessageReadDoc): string | null {
  const prefixo = `${doc.targetMessageId}|`;
  if (!doc._id.startsWith(prefixo)) return null;
  const chave = doc._id.slice(prefixo.length);
  return chave || null;
}

/**
 * Id do WhatsApp de uma pessoa, preferindo o `@c.us` — é a forma que a lista de
 * participantes entrega, e a que faz `resolveIdentity` chegar no telefone.
 */
function actorIdOf(pessoa: PersonDoc): string | null {
  const aliases = pessoa.aliases ?? [];
  const cus = aliases.find((a) => a.endsWith('@c.us'));
  if (cus) return cus;
  const lid = aliases.find((a) => a.endsWith('@lid'));
  if (lid) return lid;
  const digitos = (pessoa.phone ?? '').replace(/\D/g, '');
  return digitos ? `${digitos}@c.us` : null;
}

/** Primeiro `capturedAt` visto por grupo, para datar o snapshot remontado. */
function earliestByGroup(eventos: CapturedEvent[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const evento of eventos) {
    const id = evento.group?.id;
    if (!id) continue;
    const atual = mapa.get(id);
    if (!atual || Date.parse(evento.capturedAt) < Date.parse(atual)) {
      mapa.set(id, evento.capturedAt);
    }
  }
  return mapa;
}

function countByType(eventos: CapturedEvent[]): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const evento of eventos) contagem[evento.type] = (contagem[evento.type] ?? 0) + 1;
  return contagem;
}

function withSuffix(base: MongoConfig, suffix: string): MongoConfig {
  return { ...base, collectionSuffix: suffix };
}

/**
 * `--to=` com valor vazio é legítimo: é exatamente o sufixo de produção. Por
 * isso a flag é obrigatória mesmo quando o valor é nada — apagar o sufixo tem
 * de ser um ato deliberado, não o default de quem esqueceu o argumento.
 */
function parseArgs(args: string[]): Options {
  let from = '_teste';
  let to: string | null = null;
  let outFile: string | null = null;
  let dryRun = false;
  const groupIds: string[] = [];

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) to = arg.slice('--to='.length);
    else if (arg.startsWith('--out=')) outFile = arg.slice('--out='.length);
    else if (arg.startsWith('--')) fail(`argumento desconhecido: ${arg}`);
    else groupIds.push(arg.trim());
  }

  if (to === null) fail('faltou --to=<sufixo>. Para produção, use --to= (vazio).');
  if (from === to) fail('origem e destino são o mesmo sufixo; nada a fazer.');
  if (groupIds.length === 0) fail('informe ao menos um id de grupo.');

  const invalidos = groupIds.filter((id) => !isGroupId(id));
  if (invalidos.length) fail(`id de grupo inválido: ${invalidos.join(', ')}`);

  return {
    from,
    to: to as string,
    groupIds,
    dryRun,
    outFile: outFile
      ? path.resolve(outFile)
      : path.join(PROJECT_ROOT, 'data', `migracao-${localStamp()}.jsonl`),
  };
}

function fail(mensagem: string): never {
  log.error(mensagem);
  process.exit(1);
}

main().catch((error) => {
  log.error('falha na migração', error);
  process.exit(1);
});
