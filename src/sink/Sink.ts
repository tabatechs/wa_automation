import type { CapturedEvent } from '../types';

/**
 * Destino dos eventos capturados.
 *
 * Toda a captura depende só desta interface, então trocar JSONL por Postgres,
 * S3 ou um webhook na fase 2 não toca nenhum coletor.
 */
export interface Sink {
  readonly name: string;
  write(event: CapturedEvent): Promise<void>;
  close(): Promise<void>;
}
