/**
 * Checkpoint de retomada, por grupo.
 *
 * Guarda o suficiente para responder, ao religar: "o que aconteceu enquanto eu
 * estava fora?". Duas coisas bastam —
 *
 *   - até quando já registramos mensagens (`lastMessageAt`), mais os ids
 *     recentes já emitidos, para não duplicar nada no backfill;
 *   - quem eram os participantes (`participantIds`), para diferenciar contra a
 *     lista atual e detectar entradas/saídas ocorridas com o monitor parado.
 *
 * Gravado com tmp + rename: um crash no meio da escrita não corrompe o estado.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../util/logger';
import { localIso } from '../util/time';

const log = createLogger('checkpoint');
const STATE_VERSION = 1;

/**
 * Teto de ids guardados por grupo. Só existem para deduplicar o backfill, que
 * olha uma janela recente — manter o histórico inteiro faria o arquivo crescer
 * sem limite sem nenhum ganho.
 */
const MAX_IDS_PER_GROUP = 5_000;

export interface GroupCheckpoint {
  /** Epoch ms da mensagem mais recente já registrada. */
  lastMessageAt: number | null;
  lastMessageId: string | null;
  /** Ids já emitidos (mais recentes ao final). */
  emittedMessageIds: string[];
  /** Participantes conhecidos na última execução. */
  participantIds: string[];
  /**
   * Se já registramos a lista de participantes deste grupo alguma vez.
   *
   * Flag própria, e não `updatedAt === null`, porque o backfill emite mensagens
   * (mexendo em updatedAt) antes de reconciliar os participantes: usar updatedAt
   * faria o primeiro run reportar o grupo inteiro como "entrou agora".
   */
  participantsSeen: boolean;
  updatedAt: string | null;
}

interface PersistedCheckpoints {
  version: number;
  groups: Record<string, GroupCheckpoint>;
}

function emptyCheckpoint(): GroupCheckpoint {
  return {
    lastMessageAt: null,
    lastMessageId: null,
    emittedMessageIds: [],
    participantIds: [],
    participantsSeen: false,
    updatedAt: null,
  };
}

export interface ParticipantDiff {
  added: string[];
  removed: string[];
  /** true no primeiro contato com o grupo, quando não há base de comparação. */
  firstRun: boolean;
}

export class CheckpointStore {
  private readonly groups = new Map<string, GroupCheckpoint>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly filePath: string;
  private dirty = false;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'checkpoint.json');
    this.load();
  }

  get(groupId: string): GroupCheckpoint {
    let entry = this.groups.get(groupId);
    if (!entry) {
      entry = emptyCheckpoint();
      this.groups.set(groupId, entry);
    }
    return entry;
  }

  /** true no primeiro boot com este grupo (nunca registramos nada dele). */
  isFirstRun(groupId: string): boolean {
    return this.get(groupId).updatedAt === null;
  }

  /**
   * Registra uma mensagem como emitida.
   * Devolve false se ela já havia sido emitida antes — o chamador deve pular.
   */
  markMessageEmitted(groupId: string, messageId: string, at: number | null): boolean {
    if (!messageId) return false;

    let ids = this.seen.get(groupId);
    if (!ids) {
      ids = new Set(this.get(groupId).emittedMessageIds);
      this.seen.set(groupId, ids);
    }
    if (ids.has(messageId)) return false;

    ids.add(messageId);
    const entry = this.get(groupId);
    entry.emittedMessageIds.push(messageId);
    if (entry.emittedMessageIds.length > MAX_IDS_PER_GROUP) {
      const dropped = entry.emittedMessageIds.splice(
        0,
        entry.emittedMessageIds.length - MAX_IDS_PER_GROUP,
      );
      for (const id of dropped) ids.delete(id);
    }
    if (at !== null && (entry.lastMessageAt === null || at > entry.lastMessageAt)) {
      entry.lastMessageAt = at;
      entry.lastMessageId = messageId;
    }
    entry.updatedAt = localIso();
    this.dirty = true;
    return true;
  }

  /**
   * Compara a lista atual de participantes com a da última execução e guarda a
   * nova. No primeiro contato não há diferença a reportar — o group_snapshot
   * inicial já descreve o grupo inteiro.
   */
  diffParticipants(groupId: string, currentIds: readonly string[]): ParticipantDiff {
    const entry = this.get(groupId);
    const firstRun = !entry.participantsSeen;
    const previous = new Set(entry.participantIds);
    // Id vazio é sintoma de metadado que não sincronizou, nunca uma pessoa.
    // Deixá-lo entrar colapsava todos os quebrados num só elemento e a
    // diferença acusava saída em massa.
    const current = new Set(currentIds.filter((id) => id));

    // Lista vazia é quase sempre metadado que ainda não sincronizou, não um
    // grupo que esvaziou: não há diferença a reportar, e gravá-la faria a
    // próxima execução acusar que o grupo inteiro entrou de novo.
    if (current.size === 0) {
      entry.updatedAt = localIso();
      this.dirty = true;
      return { added: [], removed: [], firstRun };
    }

    const added = firstRun ? [] : [...current].filter((id) => !previous.has(id));
    const removed = firstRun ? [] : [...previous].filter((id) => !current.has(id));

    entry.participantIds = [...current];
    entry.participantsSeen = true;
    entry.updatedAt = localIso();
    this.dirty = true;

    return { added, removed, firstRun };
  }

  save(): void {
    if (!this.dirty) return;
    const payload: PersistedCheckpoints = { version: STATE_VERSION, groups: {} };
    for (const [groupId, entry] of this.groups) payload.groups[groupId] = entry;

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (error) {
      log.warn('não foi possível persistir o checkpoint', error);
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedCheckpoints;
      if (raw?.version !== STATE_VERSION || !raw.groups) return;
      for (const [groupId, entry] of Object.entries(raw.groups)) {
        this.groups.set(groupId, { ...emptyCheckpoint(), ...entry });
      }
      log.info('checkpoint restaurado', { grupos: this.groups.size });
    } catch {
      // Primeira execução ou arquivo ilegível: trata tudo como primeiro contato.
    }
  }
}
