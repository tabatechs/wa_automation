import { createWriteStream, mkdirSync, statSync, renameSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { CapturedEvent } from '../types';
import { createLogger } from '../util/logger';
import { localStamp } from '../util/time';
import type { Sink } from './Sink';

const log = createLogger('sink:jsonl');

export interface JsonlSinkOptions {
  filePath: string;
  /** Ao ultrapassar este tamanho, o arquivo é rotacionado. */
  maxBytes: number;
}

/**
 * Grava um evento por linha em append.
 *
 * JSON Lines em vez de um array JSON único porque o append é atômico e barato:
 * um array exigiria reescrever o arquivo inteiro a cada evento e deixaria um JSON
 * corrompido se o processo morresse no meio. `npm run compact` converte para array
 * quando for preciso consumir como .json.
 *
 * As escritas passam por uma fila serializada. Vários coletores emitem em paralelo
 * e escritas concorrentes num mesmo stream podem intercalar linhas parciais.
 */
export class JsonlSink implements Sink {
  readonly name = 'jsonl';

  private stream: WriteStream;
  private bytesWritten: number;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: JsonlSinkOptions) {
    mkdirSync(path.dirname(options.filePath), { recursive: true });
    this.bytesWritten = currentSize(options.filePath);
    this.stream = createWriteStream(options.filePath, { flags: 'a' });
    this.stream.on('error', (error) => log.error('falha no stream de eventos', error));
  }

  write(event: CapturedEvent): Promise<void> {
    if (this.closed) return Promise.resolve();

    // Encadeia na fila para garantir ordem e linhas íntegras.
    this.queue = this.queue.then(() => this.writeNow(event)).catch((error) => {
      // Um evento perdido não pode derrubar o monitor nem travar a fila.
      log.error('falha ao gravar evento', error);
    });
    return this.queue;
  }

  private async writeNow(event: CapturedEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line);

    if (this.bytesWritten > 0 && this.bytesWritten + size > this.options.maxBytes) {
      await this.rotate();
    }

    await new Promise<void>((resolve, reject) => {
      this.stream.write(line, (error) => (error ? reject(error) : resolve()));
    });
    this.bytesWritten += size;
  }

  private async rotate(): Promise<void> {
    const { filePath } = this.options;
    const stamp = localStamp();
    const ext = path.extname(filePath);
    const rotated = path.join(
      path.dirname(filePath),
      `${path.basename(filePath, ext)}-${stamp}${ext}`,
    );

    await this.endStream();
    try {
      renameSync(filePath, rotated);
      log.info('arquivo de eventos rotacionado', { rotated: path.basename(rotated) });
    } catch (error) {
      log.error('falha ao rotacionar, continuando no arquivo atual', error);
    }

    this.stream = createWriteStream(filePath, { flags: 'a' });
    this.stream.on('error', (err) => log.error('falha no stream de eventos', err));
    this.bytesWritten = currentSize(filePath);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    await this.endStream();
  }

  private endStream(): Promise<void> {
    return new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

function currentSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
