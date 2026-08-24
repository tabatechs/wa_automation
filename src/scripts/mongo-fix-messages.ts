/**
 * Remove de `messages` o que não é fala e conserta o que isso inflou.
 *
 * ## O que foi
 *
 * `onAnyMessage` entrega também os avisos de sistema do WhatsApp, e não havia
 * filtro. O maior deles é o `gp2` — o balão cinza de "Fulano adicionou
 * Beltrano" —, que é a mesma entrada/saída já registrada em `member_events`,
 * vista pelo lado do chat. Sem filtro, cada entrada de participante virava
 * `messagesSent += 1` para alguém.
 *
 * Em produção, 24/08/2026: 61 dos 500 documentos de `messages` eram `gp2`
 * (12%), e 37 das 119 pessoas com "mensagem" nunca tinham escrito uma linha —
 * classificadas como `occasional` ou `observer` quando são `lurker`.
 *
 * A lista completa e o critério estão em `src/util/messageTypes.ts`.
 *
 * ## Por que a limpeza é curta
 *
 * Diferente do `mongo:fix-members`, aqui quase tudo é derivado. `mongo:build
 * --full` zera e reconta `people` e `groups` a partir de `messages`
 * (`recountHotCounters`), e reescreve `activity_daily` do mesmo lugar
 * (`rebuildActivityDaily`). Então basta apagar os documentos e recalcular.
 *
 * A exceção é `lastMessageAt`: ele só existe como `$max` do caminho quente e
 * **não** é recalculado pelo `--full`. Deixá-lo como está diria que a pessoa
 * falou no dia em que apenas entrou no grupo, e é justamente o campo que
 * responde "há quanto tempo essa pessoa sumiu". Por isso o script o reconstrói
 * à mão a partir do que sobrou.
 *
 * Roda em seco por padrão; `--apply` executa.
 */

import { MongoClient, type Db } from 'mongodb';
import { loadConfig } from '../config';
import { COLLECTIONS } from '../mongo/schema';
import { createLogger } from '../util/logger';
import { NON_SPEECH_TYPES } from '../util/messageTypes';

const log = createLogger('mongo:fix-messages');

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
  const mensagens = db.collection(`${COLLECTIONS.messages}${sufixo}`);

  const filtro = { messageType: { $in: [...NON_SPEECH_TYPES] } };

  const porTipo = await mensagens
    .aggregate<{ _id: string; n: number }>([
      { $match: filtro },
      { $group: { _id: '$messageType', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  if (porTipo.length === 0) {
    log.info('nada a limpar');
    await client.close();
    return;
  }

  const total = porTipo.reduce((s, t) => s + t.n, 0);
  for (const t of porTipo) log.info('sem fala', { messageType: t._id, quantidade: t.n });

  // Quem fica sem nenhuma mensagem depois da limpeza deixa de ser "alguém que
  // fala" — é o efeito que importa, e o que o número solto não mostra.
  const autores = await afetados(mensagens, filtro);
  const emudecidos = await semNadaDepois(mensagens, autores);

  log.info(aplicar ? 'aplicando' : 'simulação (use --apply para executar)', {
    documentos: total,
    pessoasAfetadas: autores.length,
    pessoasQueFicamSemMensagem: emudecidos.length,
  });

  if (!aplicar) {
    await client.close();
    return;
  }

  const grupos = await mensagens.distinct('groupId', filtro);
  const { deletedCount } = await mensagens.deleteMany(filtro);
  log.info('documentos removidos', { deletedCount });

  await recomputarLastMessageAt(db, sufixo, autores, grupos as string[]);

  log.info('pronto — agora rode `npm run mongo:build -- --full` para recontar');
  await client.close();
}

async function afetados(
  mensagens: ReturnType<Db['collection']>,
  filtro: object,
): Promise<string[]> {
  const ids = await mensagens.distinct('authorId', filtro);
  return ids.filter((id): id is string => typeof id === 'string');
}

/** Autores cujas mensagens restantes são zero depois de tirar o ruído. */
async function semNadaDepois(
  mensagens: ReturnType<Db['collection']>,
  autores: string[],
): Promise<string[]> {
  const restantes = await mensagens
    .aggregate<{ _id: string }>([
      {
        $match: {
          authorId: { $in: autores },
          messageType: { $nin: [...NON_SPEECH_TYPES] },
        },
      },
      { $group: { _id: '$authorId' } },
    ])
    .toArray();
  const comFala = new Set(restantes.map((r) => r._id));
  return autores.filter((id) => !comFala.has(id));
}

/**
 * Reescreve `lastMessageAt` a partir do que sobrou. `null` quando não sobrou
 * mensagem nenhuma — o campo tem de admitir "nunca falou", senão a pessoa fica
 * com a data da entrada no grupo para sempre.
 */
async function recomputarLastMessageAt(
  db: Db,
  sufixo: string,
  pessoas: string[],
  grupos: string[],
): Promise<void> {
  const mensagens = db.collection(`${COLLECTIONS.messages}${sufixo}`);

  for (const [campo, ids, colecao] of [
    ['authorId', pessoas, COLLECTIONS.people],
    ['groupId', grupos, COLLECTIONS.groups],
  ] as const) {
    if (ids.length === 0) continue;

    const maximos = await mensagens
      .aggregate<{ _id: string; ultima: Date | null }>([
        { $match: { [campo]: { $in: ids }, sentAt: { $ne: null } } },
        { $group: { _id: `$${campo}`, ultima: { $max: '$sentAt' } } },
      ])
      .toArray();

    const porId = new Map(maximos.map((m) => [m._id, m.ultima]));
    const alvo = db.collection(`${colecao}${sufixo}`);
    let zerados = 0;
    for (const id of ids) {
      const ultima = porId.get(id) ?? null;
      if (ultima === null) zerados += 1;
      await alvo.updateOne({ _id: id as unknown as never }, { $set: { lastMessageAt: ultima } });
    }
    log.info('lastMessageAt reconstruído', { colecao, documentos: ids.length, semMensagem: zerados });
  }
}

main().catch((error) => {
  log.error('falha', error);
  process.exit(1);
});
