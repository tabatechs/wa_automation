/**
 * Escreve o mesmo evento em vários destinos.
 *
 * O ponto é o isolamento: o JSONL é o log durável e não pode ser afetado por
 * uma indisponibilidade do MongoDB. Por isso as escritas são disparadas em
 * paralelo e o fracasso de um destino nunca impede o outro — cada uma responde
 * pelos próprios erros, e aqui elas só são registradas.
 */

import type { CapturedEvent } from '../types';
import { createLogger } from '../util/logger';
import type { Sink } from './Sink';

const log = createLogger('sink:multi');

export class MultiSink implements Sink {
  readonly name: string;

  constructor(private readonly sinks: Sink[]) {
    this.name = `multi(${sinks.map((s) => s.name).join('+')})`;
  }

  async write(event: CapturedEvent): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.write(event)));
    this.report(results, 'gravar');
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.close()));
    this.report(results, 'fechar');
  }

  private report(results: PromiseSettledResult<void>[], acao: string): void {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error(`falha ao ${acao} em um destino`, {
          destino: this.sinks[index]?.name ?? index,
          error: String(result.reason),
        });
      }
    });
  }
}
