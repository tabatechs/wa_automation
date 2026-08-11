import type { Client } from '@open-wa/wa-automate';
import type { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import type { Roster } from '../enrich/roster';
import type { Sink } from '../sink/Sink';
import type { CapturedEvent } from '../types';

/** Tudo que um coletor precisa para trabalhar. */
export interface CollectorContext {
  client: Client;
  config: AppConfig;
  roster: Roster;
  sink: Sink;
  /**
   * true se o grupo está na whitelist. Chame na PRIMEIRA linha de cada handler.
   * É um type guard: depois dele o chatId já está estreitado para string.
   */
  isMonitored(chatId: string | null | undefined): chatId is string;
  /** Nome do grupo, resolvido e cacheado. */
  groupName(groupId: string): Promise<string | null>;
  emit(event: CapturedEvent): Promise<void>;
  newEventId: typeof randomUUID;
}

export interface Collector {
  readonly name: string;
  start(ctx: CollectorContext): Promise<void>;
  stop(): Promise<void>;
}
