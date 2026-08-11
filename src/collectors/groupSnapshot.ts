/**
 * Emite o estado completo de um grupo (assunto, dono, lista de participantes com
 * número/nome/admin). Compartilhado entre o boot e o coletor de participantes.
 */

import { EVENT_SCHEMA_VERSION } from '../types';
import type { CapturedEvent, GroupSnapshotPayload } from '../types';
import { createLogger } from '../util/logger';
import type { CollectorContext } from './Collector';

const log = createLogger('group-snapshot');

export async function emitGroupSnapshot(
  ctx: CollectorContext,
  groupId: string,
  reason: GroupSnapshotPayload['reason'],
): Promise<void> {
  // No boot vale esperar os metadados sincronizarem: um grupo grande pode
  // responder com lista vazia nos primeiros segundos após a sessão ficar pronta.
  const participants = await ctx.roster.groupMembers(groupId, reason === 'boot');

  let subject: string | null = null;
  let description: string | null = null;
  let owner: string | null = null;

  try {
    const info = (await ctx.client.getGroupInfo(
      groupId as Parameters<typeof ctx.client.getGroupInfo>[0],
    )) as
      | {
          subject?: string;
          desc?: string;
          owner?: string | { _serialized?: string };
        }
      | undefined;

    subject = typeof info?.subject === 'string' ? info.subject : null;
    description = typeof info?.desc === 'string' ? info.desc : null;
    owner =
      typeof info?.owner === 'string'
        ? info.owner
        : (info?.owner?._serialized ?? null);
  } catch (error) {
    log.warn('getGroupInfo falhou; snapshot sai só com os participantes', {
      groupId,
      error: String(error),
    });
  }

  const payload: GroupSnapshotPayload = {
    subject,
    description,
    owner,
    participantCount: participants.length,
    participants,
    reason,
  };

  const event: CapturedEvent = {
    schema: EVENT_SCHEMA_VERSION,
    eventId: ctx.newEventId(),
    type: 'group_snapshot',
    capturedAt: new Date().toISOString(),
    group: { id: groupId, name: subject ?? (await ctx.groupName(groupId)) },
    actor: null,
    payload,
  };

  await ctx.emit(event);
}
