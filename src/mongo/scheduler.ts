/**
 * Dispara o recálculo das métricas de tempos em tempos, dentro do monitor.
 *
 * O caminho quente já deixa os contadores brutos atualizados a cada evento;
 * isto aqui cuida do que é caro — percentis, concentração, tendências, fusão
 * de identidades. Roda fora do fluxo de captura e nunca o bloqueia: se uma
 * passada demora, a seguinte é simplesmente pulada.
 */

import type { MongoConfig } from '../config';
import { createLogger } from '../util/logger';
import { MongoStore } from './client';
import { MetricsBuilder } from './metrics';

const log = createLogger('mongo:scheduler');

export class MetricsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private store: MongoStore | null = null;

  constructor(private readonly config: MongoConfig) {}

  start(): void {
    if (!this.config.uri || this.config.metricsRefreshMs <= 0) return;

    this.store = new MongoStore(this.config);
    const builder = new MetricsBuilder(this.store);

    this.timer = setInterval(() => {
      // Uma passada por vez. Em base grande o recálculo pode passar do
      // intervalo, e enfileirar passadas só faria a fila crescer.
      if (this.running) {
        log.debug('recálculo anterior ainda rodando; pulando esta janela');
        return;
      }
      this.running = true;
      void builder
        .refresh()
        .catch((error) => log.error('recálculo agendado falhou', error))
        .finally(() => {
          this.running = false;
        });
    }, this.config.metricsRefreshMs);

    this.timer.unref?.();
    log.info('recálculo agendado ativo', { intervaloMs: this.config.metricsRefreshMs });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.store?.close();
    this.store = null;
  }
}
