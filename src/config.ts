/**
 * Carrega e valida a configuração: variáveis de ambiente + config/groups.json.
 *
 * A whitelist de grupos é o controle de privacidade central do projeto — por isso
 * ela é validada de forma estrita e exposta como um Set para checagem O(1) na
 * primeira linha de cada handler.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { isGroupId } from './util/phone';

loadDotenv();

export const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);
}

const envSchema = z.object({
  SESSION_ID: z.string().min(1).default('wa-monitor'),
  // Headless por padrão: sem janela do Chromium, QR direto no terminal.
  HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Escape hatch: usar o Chrome instalado no sistema em vez do Chromium que o
  // puppeteer já baixou. Não é necessário — ver o comentário em session.ts.
  USE_CHROME: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  // Caminho explícito do navegador. Vazio = usa o Chromium do puppeteer.
  CHROME_PATH: z.string().optional(),
  // Sobrescreve o user-agent. Vazio = usa o padrão calculado em session.ts.
  USER_AGENT: z.string().optional(),
  EVENTS_FILE: z.string().min(1).default('data/events.jsonl'),
  EVENTS_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  REACTION_POLL_MS: z.coerce.number().int().min(5_000).default(30_000),
  // Teto de mensagens por grupo sob observação de reações. Alto de propósito:
  // o custo por ciclo é uma chamada por grupo, independente da janela.
  REACTION_WINDOW_SIZE: z.coerce.number().int().positive().default(2_000),
  REACTION_WINDOW_HOURS: z.coerce.number().positive().default(48),
  ROSTER_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  // --- Confirmações de leitura das mensagens próprias ---
  READ_RECEIPTS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Intervalo alto de propósito: o horário da leitura vem do WhatsApp, não do
  // momento em que perguntamos, e o número de eventos é o mesmo em qualquer
  // cadência (um por pessoa por mensagem). Perguntar de minuto em minuto só
  // multiplicaria consultas na sessão sem melhorar dado nenhum.
  READ_RECEIPT_POLL_MS: z.coerce.number().int().min(10_000).default(15 * 60 * 1000),
  // Depois disso a mensagem sai da vigilância. Quem ia ler já leu; continuar
  // perguntando por mensagens de dias atrás só gasta consulta.
  READ_RECEIPT_WINDOW_HOURS: z.coerce.number().positive().default(48),
  // Teto de consultas por ciclo. Aqui o custo é por MENSAGEM, não por grupo
  // como nas reações — sem teto, um dia movimentado viraria uma rajada.
  READ_RECEIPT_MAX_PER_CYCLE: z.coerce.number().int().positive().default(40),
  // --- Backfill do histórico ---
  BACKFILL_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Janela em dias usada no PRIMEIRO contato com um grupo. Nas execuções
  // seguintes, o checkpoint manda e só o que é novo é lido.
  BACKFILL_DAYS: z.coerce.number().positive().default(7),
  // Teto de segurança: evita paginar indefinidamente num grupo muito ativo.
  BACKFILL_MAX_MESSAGES: z.coerce.number().int().positive().default(5_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // --- MongoDB ---
  // Sem MONGODB_URI o Mongo simplesmente não sobe e o monitor segue como antes,
  // gravando só o JSONL. Nada aqui é obrigatório.
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().min(1).default('wa_monitor'),
  MONGO_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Sufixo aplicado a TODAS as coleções. Começa em "_teste" de propósito:
  // virar produção é esvaziar esta variável, sem tocar em código.
  MONGO_COLLECTION_SUFFIX: z.string().default('_teste'),
  MONGO_RAW_LOG: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // 0 = o log bruto nunca expira. Ver o orçamento de espaço no README.
  MONGO_RAW_LOG_TTL_DAYS: z.coerce.number().int().min(0).default(0),
  MONGO_FLUSH_MS: z.coerce.number().int().min(100).default(2_000),
  MONGO_FLUSH_MAX: z.coerce.number().int().positive().default(200),
  // Recálculo das métricas caras dentro do monitor. 0 desliga (só sob demanda).
  METRICS_REFRESH_MS: z.coerce.number().int().min(0).default(5 * 60 * 1000),
});

const groupEntrySchema = z.object({
  id: z.string().refine(isGroupId, { message: 'o id de um grupo deve terminar em @g.us' }),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
});

const groupsFileSchema = z.object({
  groups: z.array(groupEntrySchema).default([]),
});

export interface MonitoredGroup {
  id: string;
  label?: string;
}

export interface AppConfig {
  sessionId: string;
  headless: boolean;
  useChrome: boolean;
  chromePath?: string;
  userAgent?: string;
  /** Diretório onde o open-wa guarda as credenciais da sessão. */
  sessionDataPath: string;
  eventsFile: string;
  eventsMaxBytes: number;
  stateDir: string;
  reactionPollMs: number;
  reactionWindowSize: number;
  reactionWindowMs: number;
  rosterTtlMs: number;
  readReceiptsEnabled: boolean;
  readReceiptPollMs: number;
  readReceiptWindowMs: number;
  readReceiptMaxPerCycle: number;
  backfillEnabled: boolean;
  backfillDays: number;
  backfillMaxMessages: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  groups: MonitoredGroup[];
  /** Ids habilitados, para checagem rápida de whitelist. */
  groupIds: Set<string>;
  mongo: MongoConfig;
}

export interface MongoConfig {
  /** Vazio = Mongo desligado; o monitor grava só o JSONL. */
  uri: string | null;
  db: string;
  collectionSuffix: string;
  rawLog: boolean;
  rawLogTtlDays: number;
  flushMs: number;
  flushMax: number;
  metricsRefreshMs: number;
}

export function loadConfig(): AppConfig {
  const parsedEnv = envSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    throw new Error(`Configuração de ambiente inválida:\n${formatIssues(parsedEnv.error)}`);
  }
  const env = parsedEnv.data;

  const groupsPath = path.join(PROJECT_ROOT, 'config', 'groups.json');
  let rawGroups: unknown;
  try {
    rawGroups = JSON.parse(readFileSync(groupsPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Não foi possível ler ${groupsPath}: ${(error as Error).message}\n` +
        'Crie o arquivo com {"groups": []} ou rode `npm run list-groups` para descobrir os ids.',
    );
  }

  const parsedGroups = groupsFileSchema.safeParse(rawGroups);
  if (!parsedGroups.success) {
    throw new Error(`config/groups.json inválido:\n${formatIssues(parsedGroups.error)}`);
  }

  const enabled = parsedGroups.data.groups.filter((g) => g.enabled);
  const groups: MonitoredGroup[] = enabled.map((g) => ({ id: g.id, label: g.label }));

  return {
    sessionId: env.SESSION_ID,
    headless: env.HEADLESS,
    useChrome: env.USE_CHROME,
    ...(env.CHROME_PATH ? { chromePath: env.CHROME_PATH } : {}),
    ...(env.USER_AGENT ? { userAgent: env.USER_AGENT } : {}),
    sessionDataPath: resolveFromRoot('data/session'),
    eventsFile: resolveFromRoot(env.EVENTS_FILE),
    eventsMaxBytes: env.EVENTS_MAX_BYTES,
    stateDir: resolveFromRoot('data/state'),
    reactionPollMs: env.REACTION_POLL_MS,
    reactionWindowSize: env.REACTION_WINDOW_SIZE,
    // A janela de reações nunca pode ser mais estreita que a do backfill: uma
    // mensagem recuperada do histórico precisa permanecer sob observação tempo
    // suficiente para ter as reações lidas, senão entra e sai da janela sem
    // nunca ser varrida. Alargar custa pouco — a varredura é uma chamada por
    // grupo, e a janela só decide quais mensagens são comparadas.
    reactionWindowMs: Math.max(
      env.REACTION_WINDOW_HOURS * 60 * 60 * 1000,
      env.BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    ),
    rosterTtlMs: env.ROSTER_TTL_MS,
    readReceiptsEnabled: env.READ_RECEIPTS_ENABLED,
    readReceiptPollMs: env.READ_RECEIPT_POLL_MS,
    readReceiptWindowMs: env.READ_RECEIPT_WINDOW_HOURS * 60 * 60 * 1000,
    readReceiptMaxPerCycle: env.READ_RECEIPT_MAX_PER_CYCLE,
    backfillEnabled: env.BACKFILL_ENABLED,
    backfillDays: env.BACKFILL_DAYS,
    backfillMaxMessages: env.BACKFILL_MAX_MESSAGES,
    logLevel: env.LOG_LEVEL,
    groups,
    groupIds: new Set(groups.map((g) => g.id)),
    mongo: {
      uri: env.MONGO_ENABLED && env.MONGODB_URI ? env.MONGODB_URI : null,
      db: env.MONGODB_DB,
      collectionSuffix: env.MONGO_COLLECTION_SUFFIX,
      rawLog: env.MONGO_RAW_LOG,
      rawLogTtlDays: env.MONGO_RAW_LOG_TTL_DAYS,
      flushMs: env.MONGO_FLUSH_MS,
      flushMax: env.MONGO_FLUSH_MAX,
      metricsRefreshMs: env.METRICS_REFRESH_MS,
    },
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`).join('\n');
}
