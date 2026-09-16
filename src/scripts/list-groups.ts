/**
 * Lista todos os grupos da conta conectada, para você escolher quais monitorar.
 *
 * Uso:
 *   npm run list-groups              # todos
 *   npm run list-groups -- apoio     # só os que têm "apoio" no nome
 *
 * Numa conta com dezenas de grupos a saída não cabe no terminal, e rolar para
 * trás nem sempre alcança o começo — por isso a lista **sempre** vai também
 * para `data/grupos.json` e `data/grupos.txt`. O terminal é a cópia
 * descartável; o arquivo é o que se consulta depois.
 *
 * Copie o `id` desejado para MONITORED_GROUPS, no .env.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@open-wa/wa-automate';
import { loadConfig } from '../config';
import { GroupDirectory } from '../enrich/groupDirectory';
import { startSession, stopSession } from '../session';
import { createLogger, setLogLevel } from '../util/logger';
import { localIso } from '../util/time';

const log = createLogger('list-groups');

interface GroupRow {
  id: string;
  name: string;
  participantes: number | null;
  /** Já está na whitelist ativa (MONITORED_GROUPS, no .env). */
  monitorado: boolean;
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // Tudo depois de `--` é filtro por nome. Junta em um termo só para aceitar
  // "npm run list-groups -- grupo de apoio" sem exigir aspas.
  const filtro = process.argv.slice(2).join(' ').trim().toLowerCase();

  const client = await startSession(config);
  try {
    const brutos = (await consultarServidor(client)) ?? (await lerMemoria(client));
    if (brutos.length === 0) {
      log.warn('nenhum grupo encontrado nesta conta');
      return;
    }

    const rows: GroupRow[] = brutos
      .map((g) => ({ ...g, monitorado: config.groupIds.has(g.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const arquivos = gravar(config.eventsFile, rows);

    const visiveis = filtro
      ? rows.filter((r) => r.name.toLowerCase().includes(filtro) || r.id.includes(filtro))
      : rows;

    const cabecalho = filtro
      ? `\n${visiveis.length} de ${rows.length} grupos casam com "${filtro}"\n\n`
      : `\nGrupos encontrados: ${rows.length}\n\n`;
    process.stdout.write(cabecalho);

    // Uma linha por grupo: o que antes ocupava três linhas e estourava o
    // scrollback numa conta com muitos grupos.
    for (const row of visiveis) {
      const marca = row.monitorado ? '*' : ' ';
      const total = row.participantes === null ? '   ?' : String(row.participantes).padStart(4);
      process.stdout.write(`${marca} ${total}  ${row.id}  ${row.name}\n`);
    }

    process.stdout.write(
      `\n* = já em MONITORED_GROUPS ` +
        `(${rows.filter((r) => r.monitorado).length})\n` +
        `Lista completa em ${arquivos.join(' e ')}\n`,
    );

    if (filtro && visiveis.length > 0 && visiveis.length <= 20) {
      // Pronto para colar no .env: só os ids, um por linha, como o parser lê.
      const ids = visiveis.map((r) => r.id).join(',\n');
      process.stdout.write(`\nPara MONITORED_GROUPS, no .env:\n\nMONITORED_GROUPS="${ids}"\n`);
    } else {
      process.stdout.write(
        '\nFiltre para receber a linha pronta do .env: npm run list-groups -- parte-do-nome\n',
      );
    }
  } finally {
    await stopSession(client);
  }
}

type GrupoBruto = Omit<GroupRow, 'monitorado'>;

/**
 * Pergunta ao servidor quais grupos a conta integra.
 *
 * `getAllGroups` do open-wa lê `Store.Chat`, que é só o que o WA Web tem em
 * memória — nesta conta, 17 de 179 grupos, e nem esperar nem `client.refresh()`
 * mudam isso. Ver `enrich/groupDirectory.ts`. Devolve null quando o servidor
 * não responde; aí o ponto de partida é `npm run probe-groups`.
 */
async function consultarServidor(client: Client): Promise<GrupoBruto[] | null> {
  const grupos = await new GroupDirectory(client, Infinity).all();
  if (!grupos) {
    log.warn('consulta de grupos ao servidor falhou; usando a lista em memória');
    return null;
  }
  return grupos.map((g) => ({
    id: g.id,
    name: g.subject ?? '(sem nome)',
    // Lista descartada por falta de telefone ainda tem tamanho útil aqui, mas
    // o diretório não o guarda; "?" é honesto.
    participantes: g.participants?.length ?? null,
  }));
}

/** Reserva: o que o WA Web tem em memória, possivelmente só uma fração. */
async function lerMemoria(client: Client): Promise<GrupoBruto[]> {
  const groups = (await client.getAllGroups()) ?? [];
  return groups.map((group) => ({
    id: String((group as { id?: unknown }).id ?? ''),
    name:
      (group as { name?: string }).name ??
      (group as { formattedTitle?: string }).formattedTitle ??
      '(sem nome)',
    participantes: contarParticipantes(group),
  }));
}

/**
 * Grava ao lado do events.jsonl: `data/` já é o diretório do conteúdo captura-
 * do e está no .gitignore — nome de grupo não pode ir para o repositório.
 */
function gravar(eventsFile: string, rows: GroupRow[]): string[] {
  const dir = path.dirname(eventsFile);
  const json = path.join(dir, 'grupos.json');
  const txt = path.join(dir, 'grupos.txt');

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(json, JSON.stringify({ geradoEm: localIso(), grupos: rows }, null, 2), 'utf8');
    writeFileSync(
      txt,
      rows
        .map((r) => `${r.monitorado ? '*' : ' '} ${String(r.participantes ?? '?').padStart(4)}  ${r.id}  ${r.name}`)
        .join('\n') + '\n',
      'utf8',
    );
    return [json, txt];
  } catch (error) {
    log.warn('não foi possível gravar a lista em disco', { error: String(error) });
    return ['(falhou ao gravar; só o terminal tem a lista)'];
  }
}

/** O open-wa devolve os participantes em `groupMetadata`, quando os tem. */
function contarParticipantes(group: unknown): number | null {
  const meta = (group as { groupMetadata?: { participants?: unknown[] } }).groupMetadata;
  return Array.isArray(meta?.participants) ? meta.participants.length : null;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error('falha ao listar grupos', error);
    process.exit(1);
  });
