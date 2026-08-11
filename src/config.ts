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
  REACTION_WINDOW_SIZE: z.coerce.number().int().positive().default(200),
  REACTION_WINDOW_HOURS: z.coerce.number().positive().default(48),
  ROSTER_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  groups: MonitoredGroup[];
  /** Ids habilitados, para checagem rápida de whitelist. */
  groupIds: Set<string>;
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
    reactionWindowMs: env.REACTION_WINDOW_HOURS * 60 * 60 * 1000,
    rosterTtlMs: env.ROSTER_TTL_MS,
    logLevel: env.LOG_LEVEL,
    groups,
    groupIds: new Set(groups.map((g) => g.id)),
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`).join('\n');
}
