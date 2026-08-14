/**
 * Destino MongoDB.
 *
 * Acumula eventos num buffer e descarrega em lote — cem mensagens do mesmo
 * grupo viram uma escrita em `groups`, não cem. O lote fecha por tempo
 * (`MONGO_FLUSH_MS`) ou por tamanho (`MONGO_FLUSH_MAX`), o que vier primeiro.
 *
 * Como no `JsonlSink`, as descargas passam por uma fila serializada e **erro
 * nunca sobe**: o banco é destino secundário, o JSONL é o log durável. Se o
 * Atlas cair, o monitor continua gravando em disco e o `mongo:import` recupera
 * o que ficou para trás — o `_id` determinístico faz a reimportação não
 * duplicar nada.
 */

import type { CapturedEvent } from '../types';
import { createLogger } from '../util/logger';
import { MongoStore } from '../mongo/client';
import { Ingestor } from '../mongo/ingest';
import type { MongoConfig } from '../config';
import type { Sink } from './Sink';

const log = createLogger('sink:mongo');

export class MongoSink implements Sink {
  readonly name = 'mongo';

  private buffer: CapturedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly store: MongoStore;
  private readonly ingestor: Ingestor;

  constructor(private readonly config: MongoConfig, store?: MongoStore) {
    this.store = store ?? new MongoStore(config);
    this.ingestor = new Ingestor(this.store, config.rawLog);
  }

  async write(event: CapturedEvent): Promise<void> {
    if (this.closed) return;

    this.buffer.push(event);

    if (this.buffer.length >= this.config.flushMax) {
      await this.flush();
      return;
    }

    // Um timer só por lote: o primeiro evento abre a janela, os seguintes
    // pegam carona nela.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.config.flushMs);
      // Não segura o processo vivo só por causa de um flush pendente.
      this.timer.unref?.();
    }
  }

  /** Descarrega o buffer agora. Serializada: dois flushes não se cruzam. */
  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    this.queue = this.queue.then(async () => {
      const stats = await this.ingestor.apply(batch);
      log.debug('lote gravado', {
        eventos: batch.length,
        mensagens: stats.messages,
        reacoes: stats.reactions,
        leituras: stats.reads,
        membros: stats.memberEvents,
        snapshots: stats.snapshots,
        ignorados: stats.skipped,
      });
    });

    return this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Fecha depois de drenar: o que estava no buffer no SIGINT ainda entra.
    const pending = this.buffer;
    this.buffer = [];
    if (pending.length > 0) {
      this.queue = this.queue.then(() => this.ingestor.apply(pending).then(() => undefined));
    }
    await this.queue;
    await this.store.close();
  }
}
