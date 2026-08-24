/**
 * Captura entradas, saídas, promoções e rebaixamentos nos grupos monitorados.
 *
 * Usa onGlobalParticipantsChanged (livre de licença na v4): um único listener
 * cobre todos os grupos, então acrescentar grupos à whitelist não exige registrar
 * nada novo — já nasce pronto para a fase de múltiplos grupos.
 *
 * Além do delta, emite um group_snapshot atualizado: o delta diz o que mudou, o
 * snapshot diz como o grupo ficou, e é isso que permite reconstruir o estado sem
 * replay de todo o histórico.
 */

// group-metadata não é reexportado pelo barrel do pacote; import direto.
import type { ParticipantChangedEventModel } from '@open-wa/wa-automate/dist/api/model/group-metadata';
import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, ParticipantAction, ParticipantsChangedPayload } from '../types';
import { createLogger } from '../util/logger';
import { localIso } from '../util/time';
import type { Collector, CollectorContext } from './Collector';
import { emitGroupSnapshot } from './groupSnapshot';

const log = createLogger('collector:participants');

const KNOWN_ACTIONS: Record<string, ParticipantAction> = {
  add: 'add',
  invite: 'add',
  remove: 'remove',
  leave: 'leave',
  promote: 'promote',
  demote: 'demote',
};

export class ParticipantsCollector implements Collector {
  readonly name = 'participants';

  async start(ctx: CollectorContext): Promise<void> {
    await ctx.client.onGlobalParticipantsChanged(async (event: ParticipantChangedEventModel) => {
      try {
        await this.handle(ctx, event);
      } catch (error) {
        log.error('falha ao processar mudança de participantes', error);
      }
    });
    log.info('escutando onGlobalParticipantsChanged');
  }

  private async handle(
    ctx: CollectorContext,
    event: ParticipantChangedEventModel,
  ): Promise<void> {
    const groupId = extractId(event.chat);
    if (!ctx.isMonitored(groupId)) return;

    // A lista de membros mudou; o cache precisa cair antes de resolver os nomes.
    ctx.roster.invalidateGroup(groupId);

    const rawAction = String(event.action ?? 'unknown');
    const ids = participantIds(event.who);
    if (ids.length === 0) {
      // Sem este aviso a falha é muda: o evento vira um registro sem pessoa e
      // só aparece muito depois, como uma coluna de `personId: null` no Mongo.
      log.warn('mudança de participantes sem id de pessoa', {
        groupId,
        rawAction,
        whoTipo: Array.isArray(event.who) ? 'array' : typeof event.who,
      });
    }
    const who = await ctx.roster.resolveMany(ids);
    const by = await ctx.roster.resolve(extractId(event.by));

    const payload: ParticipantsChangedPayload = {
      action: KNOWN_ACTIONS[rawAction.toLowerCase()] ?? 'unknown',
      rawAction,
      who,
      detectedOnResume: false,
    };

    const captured: CapturedEvent = {
      schema: EVENT_SCHEMA_VERSION,
      eventId: ctx.newEventId(),
      type: 'participants_changed',
      capturedAt: localIso(),
      group: { id: groupId, name: await ctx.groupName(groupId) },
      actor: by,
      payload,
    };

    await ctx.emit(captured);
    await emitGroupSnapshot(ctx, groupId, 'participants_changed');
  }

  async stop(): Promise<void> {
    // Listener vive no browser; nada a desfazer.
  }
}

/**
 * Extrai o id de um participante, aceitando as formas que o WA Web entrega.
 *
 * O WAPI embutido manda o id como **string** já serializada; o patch remoto e
 * as versões mais novas mandam o Wid cru (`{_serialized}`) ou um participante
 * (`{id: {_serialized}}`). Reduzir tudo a uma string aqui evita que a diferença
 * vaze para o resto do coletor.
 */
export function extractId(valor: unknown): string | null {
  if (typeof valor === 'string') return valor.trim() || null;
  if (!valor || typeof valor !== 'object') return null;

  const obj = valor as { _serialized?: unknown; id?: unknown };
  if (typeof obj._serialized === 'string') return obj._serialized.trim() || null;
  if (typeof obj.id === 'string') return obj.id.trim() || null;
  if (obj.id && typeof obj.id === 'object') {
    const aninhado = (obj.id as { _serialized?: unknown })._serialized;
    if (typeof aninhado === 'string') return aninhado.trim() || null;
  }
  return null;
}

/**
 * Normaliza o campo `who` do evento de participantes.
 *
 * **Armadilha que custou 100% das entradas e saídas ao vivo.** O tipo
 * `ParticipantChangedEventModel` da própria lib declara `who: string[]`, mas o
 * `WAPI.onGlobalParicipantsChanged` embutido (`dist/lib/wapi.js:1238`) chama o
 * callback com uma **string**:
 *
 *     callback({ by: undefined, action, who: eventData.id._serialized, chat })
 *
 * Ler só array fazia `Array.isArray` dar false, a lista virava `[]`, e o evento
 * era gravado sem pessoa nenhuma. O tipo mente; a única defesa é aceitar as
 * duas formas.
 */
export function participantIds(who: unknown): string[] {
  const itens = Array.isArray(who) ? who : who == null ? [] : [who];
  const ids: string[] = [];
  for (const item of itens) {
    const id = extractId(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
