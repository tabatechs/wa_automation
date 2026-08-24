/**
 * Remove os `member_events` fantasma e desfaz a conta que eles inflaram.
 *
 * ## O que foi
 *
 * O `ParticipantsCollector` lia `event.who` esperando um array, mas o
 * `WAPI.onGlobalParicipantsChanged` embutido (`dist/lib/wapi.js:1238`) manda uma
 * **string**. `Array.isArray` dava false, a lista virava `[]`, e todo evento de
 * entrada/saída ao vivo foi gravado sem pessoa — `personId: null`. Em produção
 * isso foi 100% dos eventos ao vivo.
 *
 * Esses documentos não são recuperáveis: o id da pessoa nunca chegou até nós.
 * E eles não são inofensivos — `countMemberEvent` faz
 * `group.add('joins', Math.max(payload.who.length, 1))`, então cada fantasma
 * somou 1 em `groups.joins` ou `groups.leaves`.
 *
 * `mongo:build --full` não conserta: joins/leaves só existem como contador do
 * caminho quente, não são recalculados a partir dos fatos.
 *
 * ## Como distinguir fantasma de registro legítimo
 *
 * Só os eventos **ao vivo** foram afetados. Os de reconciliação
 * (`detectedOnResume: true`) vêm da lista de participantes, que traz `@c.us`, e
 * têm pessoa. Por isso o filtro é `personId: null` E `detectedOnResume: false`.
 *
 * Roda em seco por padrão; `--apply` executa.
 */

import { MongoClient } from 'mongodb';
import { loadConfig } from '../config';
import { COLLECTIONS } from '../mongo/schema';
import { createLogger } from '../util/logger';

const log = createLogger('mongo:fix-members');

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--apply');
  const config = loadConfig();
  if (!config.mongo.uri) {
    log.error('sem MONGODB_URI no .env');
    process.exit(1);
  }

  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  const db = client.db(config.mongo.db);
  const sufixo = config.mongo.collectionSuffix;
  const membros = db.collection(`${COLLECTIONS.memberEvents}${sufixo}`);
  const grupos = db.collection(`${COLLECTIONS.groups}${sufixo}`);

  const filtro = { personId: null, detectedOnResume: false };

  const porGrupo = await membros
    .aggregate<{ _id: { groupId: string; action: string }; n: number }>([
      { $match: filtro },
      { $group: { _id: { groupId: '$groupId', action: '$action' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  if (porGrupo.length === 0) {
    log.info('nada a limpar');
    await client.close();
    return;
  }

  // Mesma regra do countMemberEvent: 'add' soma joins; 'remove' e 'leave' somam
  // leaves. Qualquer outra ação (promote/demote) não mexe nesses contadores.
  const ajustes = new Map<string, { joins: number; leaves: number }>();
  let total = 0;
  for (const linha of porGrupo) {
    const { groupId, action } = linha._id;
    total += linha.n;
    const atual = ajustes.get(groupId) ?? { joins: 0, leaves: 0 };
    if (action === 'add') atual.joins += linha.n;
    if (action === 'remove' || action === 'leave') atual.leaves += linha.n;
    ajustes.set(groupId, atual);
    log.info('fantasmas encontrados', { groupId, action: action, quantidade: linha.n });
  }

  log.info(aplicar ? 'aplicando' : 'simulação (use --apply para executar)', {
    documentos: total,
    grupos: ajustes.size,
  });

  for (const [groupId, ajuste] of ajustes) {
    log.info('correção do grupo', {
      groupId,
      joins: -ajuste.joins,
      leaves: -ajuste.leaves,
    });
    if (!aplicar) continue;
    await grupos.updateOne(
      { _id: groupId as unknown as never },
      { $inc: { joins: -ajuste.joins, leaves: -ajuste.leaves } },
    );
  }

  if (aplicar) {
    const { deletedCount } = await membros.deleteMany(filtro);
    log.info('documentos removidos', { deletedCount });
  }

  await client.close();
}

main().catch((error) => {
  log.error('falha', error);
  process.exit(1);
});
