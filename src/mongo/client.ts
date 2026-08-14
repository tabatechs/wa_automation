/**
 * Conexão com o MongoDB.
 *
 * Duas regras que valem para tudo aqui:
 *
 *   1. **Nada lança para fora.** O banco é um destino secundário; o JSONL local
 *      é que é o log durável. Se o Atlas cair, o monitor tem de continuar
 *      gravando em disco — perder métrica é aceitável, perder evento não.
 *   2. **Todo nome de coleção passa por `col()`**, que aplica o sufixo de
 *      ambiente. Enquanto `MONGO_COLLECTION_SUFFIX=_teste`, nenhuma escrita
 *      encosta nas coleções de produção.
 */

import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import type { MongoConfig } from '../config';
import { createLogger } from '../util/logger';
import { COLLECTIONS, INDEXES, type CollectionName } from './schema';

const log = createLogger('mongo');

export class MongoStore {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connecting: Promise<Db | null> | null = null;
  private indexesReady = false;
  private closed = false;

  constructor(private readonly config: MongoConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.uri);
  }

  /** Nome físico da coleção, com o sufixo de ambiente aplicado. */
  name(logical: CollectionName): string {
    return `${logical}${this.config.collectionSuffix}`;
  }

  /**
   * Conecta na primeira chamada e reaproveita depois. Devolve null quando o
   * Mongo está desligado ou a conexão falhou — o chamador segue sem banco.
   */
  async connect(): Promise<Db | null> {
    if (this.closed || !this.config.uri) return null;
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;

    this.connecting = this.doConnect(this.config.uri).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(uri: string): Promise<Db | null> {
    try {
      const client = new MongoClient(uri, {
        // O monitor é um processo só: não precisa de pool grande, e o M0
        // gratuito limita conexões simultâneas.
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10_000,
      });
      await client.connect();
      this.client = client;
      this.db = client.db(this.config.db);
      log.info('conectado ao MongoDB', {
        db: this.config.db,
        sufixo: this.config.collectionSuffix || '(nenhum)',
      });
      await this.ensureIndexes();
      return this.db;
    } catch (error) {
      log.error('falha ao conectar no MongoDB; seguindo só com o JSONL', error);
      return null;
    }
  }

  /** Coleção tipada, já com o sufixo. Null quando não há conexão. */
  async collection<T extends Document>(logical: CollectionName): Promise<Collection<T> | null> {
    const db = await this.connect();
    if (!db) return null;
    return db.collection<T>(this.name(logical));
  }

  /**
   * Cria os índices declarados em `schema.ts`. `createIndexes` é idempotente,
   * então roda a cada boot sem custo relevante.
   */
  private async ensureIndexes(): Promise<void> {
    if (this.indexesReady || !this.db) return;
    this.indexesReady = true;

    for (const [logical, specs] of Object.entries(INDEXES) as Array<
      [CollectionName, (typeof INDEXES)[CollectionName]]
    >) {
      // O log bruto pode estar desligado; não vale criar índice pra coleção vazia.
      if (logical === COLLECTIONS.events && !this.config.rawLog) continue;
      if (specs.length === 0) continue;
      try {
        await this.db.collection(this.name(logical)).createIndexes([...specs]);
      } catch (error) {
        log.warn('não foi possível criar índices', { colecao: logical, error: String(error) });
      }
    }

    await this.ensureRawLogTtl();
  }

  /**
   * TTL opcional no log bruto — a válvula de escape do plano gratuito. Zero dias
   * significa "nunca expira", e nesse caso o índice é removido se existir, para
   * que baixar o valor e voltar atrás funcione nos dois sentidos.
   */
  private async ensureRawLogTtl(): Promise<void> {
    if (!this.db || !this.config.rawLog) return;
    const collection = this.db.collection(this.name(COLLECTIONS.events));
    const indexName = 'capturedAt_ttl';

    try {
      const existing = await collection.indexExists(indexName);
      if (this.config.rawLogTtlDays > 0) {
        if (existing) return;
        await collection.createIndex(
          { capturedAt: 1 },
          { name: indexName, expireAfterSeconds: this.config.rawLogTtlDays * 86_400 },
        );
        log.info('TTL do log bruto ativado', { dias: this.config.rawLogTtlDays });
      } else if (existing) {
        await collection.dropIndex(indexName);
        log.info('TTL do log bruto removido — o log passa a ser permanente');
      }
    } catch (error) {
      log.debug('ajuste do TTL do log bruto falhou', { error: String(error) });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.db = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      log.debug('erro ao fechar a conexão', { error: String(error) });
    }
  }
}
