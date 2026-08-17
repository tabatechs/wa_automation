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
    const groupId = event.chat ? String(event.chat) : null;
    if (!ctx.isMonitored(groupId)) return;

    // A lista de membros mudou; o cache precisa cair antes de resolver os nomes.
    ctx.roster.invalidateGroup(groupId!);

    const rawAction = String(event.action ?? 'unknown');
    const who = await ctx.roster.resolveMany(
      Array.isArray(event.who) ? event.who.map(String) : [],
    );
    const by = await ctx.roster.resolve(event.by ? String(event.by) : null);

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
      group: { id: groupId!, name: await ctx.groupName(groupId!) },
      actor: by,
      payload,
    };

    await ctx.emit(captured);
    await emitGroupSnapshot(ctx, groupId!, 'participants_changed');
  }

  async stop(): Promise<void> {
    // Listener vive no browser; nada a desfazer.
  }
}
