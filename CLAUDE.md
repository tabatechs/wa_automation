# CLAUDE.md

Orientação para trabalhar neste repositório.

## O que é

Monitor de grupos do WhatsApp. Conecta um celular via `@open-wa/wa-automate`,
registra mensagens, reações e movimentação de participantes dos grupos de uma
whitelist, e mantém no MongoDB duas coleções de leitura — `people` e `groups` —
com métricas de engajamento.

O objetivo do projeto é identificar, em grupos de apoiadores de uma campanha,
quem participa mais, para convidar essas pessoas a outras atividades de
mobilização.

## A restrição central: somente leitura

**O serviço nunca envia mensagem nem executa ação de escrita nos grupos.** Não
adicione chamadas como `sendText`, `sendPoll`, `addParticipant`, `removeParticipant`
ou qualquer outra que altere estado no WhatsApp. Isso não é uma preferência de
estilo: é o que separa um monitor de um bot, e vale para qualquer funcionalidade
nova.

O segundo lado disso é a whitelist em `MONITORED_GROUPS`, no `.env`. Só o que
estiver lá é gravado. Nenhum caminho de código deve persistir evento de grupo
fora dela — `ctx.isMonitored(chatId)` é a primeira linha de todo handler.

Ela saiu de `config/groups.json` em 17/08/2026: id e nome de grupo apontam para
pessoas reais e não entram em arquivo versionado. A regra vale para
configuração nova — arquivo do repositório guarda parâmetro, `.env` guarda dado.

## Arquitetura

```
coletores  →  ctx.emit()  →  Sink  →  JSONL (durável)
                                   └→  MongoDB  →  people / groups
```

- `src/collectors/` — uma classe por fonte de evento (`messages`, `reactions`,
  `participants`, `readReceipts`, `backfill`), todas implementando `Collector`
  de `Collector.ts`. `groupSnapshot.ts` é uma função, não um coletor.
- `src/sink/` — destinos. `JsonlSink` é o log durável em disco; `MongoSink`
  acumula e grava em lote; `MultiSink` escreve nos dois e isola falhas.
- `src/mongo/` — `ingest.ts` é o caminho quente (contadores a cada evento),
  `metrics.ts` é o recálculo caro, `identity.ts` decide o `_id` de uma pessoa,
  `scoring.ts` concentra pesos e cortes do score.
- `src/enrich/` — `roster.ts` resolve nome e telefone; `lid.ts` faz a ponte
  LID→`@c.us`; `messageInfo.ts` lê os "dados da mensagem" (quem leu) pelo store.
- `src/state/checkpoint.ts` — dedupe de mensagens e ponto de retomada entre
  execuções.
- `src/util/time.ts` — o fuso do projeto. `localIso()` carimba todo evento e
  todo log em São Paulo (`…-03:00`); `timeParts()`/`dateKey()` fazem os buckets
  diários e por hora. Não use `toISOString()` em nada que seja gravado ou lido
  por humano: ele devolve UTC e a série sai partida em dois fusos.

O JSONL é sempre a fonte durável. O Mongo é destino secundário: se ele cair, o
monitor continua gravando em disco e `npm run mongo:import` recupera depois.

`docs/METRICAS.md` é o dicionário de dados: cada campo de `people` e `groups`,
como é calculado e o que responde. Mexeu na definição de uma métrica, atualize
lá — inclusive a seção dos campos que ainda não são preenchidos.

## Comandos

```bash
npm run dev            # sobe o monitor (tsx)
npm test               # testes; sem rede, sem sessão do WhatsApp
npm run typecheck      # tsc --noEmit
npm run list-groups    # ids dos grupos; grava data/grupos.txt, aceita `-- filtro`
npm run compact        # JSONL -> JSON único
npm run mongo:import   # carrega o JSONL no Mongo (idempotente)
npm run mongo:build    # recalcula métricas; --full reconta tudo do zero
npm run mongo:migrate  # move grupos de um sufixo de coleção para outro
npm run mongo:size     # uso do cluster vs. os 512 MB do plano gratuito
npm run probe-polls    # verifica se enquetes são capturáveis nesta sessão
npm run probe-reads    # verifica se dá para saber quem leu as mensagens próprias
```

`tsx` é o caminho de execução. **`dist/` está defasado** — `npm start` roda
código velho; use `npm run dev`.

## Convenções

- Comentários, logs e mensagens de commit em **português**.
- Comentário explica *por quê*, não *o quê*. O código já diz o que faz.
- TypeScript `strict` com `noUncheckedIndexedAccess`. CommonJS, Node ≥ 20.
- Testes são scripts com `node:assert` puro, rodados por `tests/run.ts`, um
  processo por arquivo. Sem framework, sem rede, sem sessão. Para testar um
  coletor, fabrique um `CollectorContext` falso e assere sobre o que foi
  emitido — ver `tests/reactions.test.ts` e `tests/ingest.test.ts`.
- Nada no caminho de captura pode lançar. Perder um nome é aceitável; perder um
  evento, não. Falha de enriquecimento ou de banco vira log.
- Todo horário gravado é ISO 8601 no fuso de São Paulo (`localIso()`), nunca
  UTC. O instante é o mesmo, e `new Date(...)` continua lendo — o que muda é
  quem lê sem converter de cabeça. Eventos anteriores a 17/08/2026 estão em
  `…Z` e continuam válidos.

## Armadilhas conhecidas

**Identidade dupla.** O WhatsApp entrega a mesma pessoa como `@lid` em mensagens
e reações, e como `@c.us` na lista de participantes. Um LID ainda pode vir com
sufixo de dispositivo (`199372465811459:71@lid`). `normalizeLid()` tira o
sufixo, e `src/mongo/identity.ts` unifica pelo telefone. Quem mexer em
resolução de ator precisa manter isso — sem essa unificação, cada apoiador vira
dois ou três documentos e todas as métricas se dividem.

**Listeners pagos.** `onReaction` e `onGroupChange` são `{@license:insiders@}`
na v4. Por isso reações são capturadas por *polling* com diff
(`collectors/reactions.ts`), não por listener.

**`page.evaluate` quebra com tsx.** O esbuild embrulha funções nomeadas num
helper `__name` que só existe no processo Node; o puppeteer envia o
*código-fonte* da função para o browser, e lá o helper não existe —
`ReferenceError: __name is not defined`. Isso manteve o `queryStore` do
`LidResolver` quebrado em silêncio por meses, absorvido pelo `try/catch`.
**Chame `preparePage(page)` de `src/util/page.ts` antes de qualquer
`page.evaluate` com função.**

**Votos de enquete não existem para um aparelho conectado.** Verificado com
sessão real: `__x_pollVotesSnapshot` é `{pollVotes: []}` e `Store.PollVote` fica
com 0 modelos, mesmo com voto emitido ao vivo. São criptografados ponta a ponta
e decifrados só no aparelho principal. `pollVotesCast` e `pollResponseRate` são
sempre nulos — não tente "consertar". Criação de enquete (autor, pergunta,
opções) é legível. `client.getPollData` do open-wa lança dentro do JS do WA Web;
vem de patch remoto e está quebrado.

**Confirmação de leitura só existe para mensagem própria.** O WhatsApp entrega
o recibo a quem enviou, e a ninguém mais — não há como saber quem leu a
mensagem de um terceiro. O `ReadReceiptsCollector` vigia apenas as mensagens
`fromMe` (as que o dono da conta escreve à mão pelo celular); o monitor
continua sem enviar nada. Diferente dos votos de enquete, o recibo **não** é
cifrado ponta a ponta e chega a todos os dispositivos conectados, por isso esta
via é viável — mas `getMessageInfo` é `insiders` e `getMessageReaders` não está
no `wapi.js`, então a rota principal é o store via `page.evaluate`. O custo é
por *mensagem*, não por grupo como nas reações: mexer no teto por ciclo tem
efeito direto no número de consultas. É também o evento de maior cardinalidade
do projeto — por isso `message_read` fica fora do log bruto, junto com
`group_snapshot`. Varrer mais rápido não gera mais eventos (é um por pessoa por
mensagem, uma vez só) nem melhora o horário, que vem do WhatsApp; só gasta
consulta.

**`getAllMessagesInChat` devolve só o que está na memória do WA Web.** Num grupo
com centenas de mensagens ela costuma devolver uma dúzia — é a janela que o WA
Web mantém carregada, e não há como ampliá-la (ver o item seguinte). Quem
escrever código novo que leia mensagens precisa contar com isso: o que não está
em memória não existe para o monitor.

**O backfill não consegue carregar histórico nesta build do WA Web, e por isso
nem tenta.** Investigado com sessão real em 14/08/2026 (`npm run probe-history`).
O que se sabe, para ninguém refazer o caminho:

- `WAPI.loadEarlierMessagesTillDate` e `WAPI.loadEarlierMessages` terminam as
  duas em `chat.loadEarlierMsgs()` — método que **não existe mais** no model.
  A "paginação manual" de reserva chamava a mesma função, então nunca houve
  reserva: os dois caminhos morriam juntos, em silêncio.
- A função existe, mas mudou de casa: é
  `require('WAWebChatLoadMessages').loadEarlierMsgs(chat)`. Chamá-la estoura
  `Cannot read properties of undefined (reading 'waitForChatLoading')` com
  QUALQUER argumento (model, Wid, string) — o que falta não é o parâmetro, é o
  contexto de conversa aberta na interface.
- As vias de banco (`WAWebFetchMessagesInThread`,
  `WAWebDBQueryChatVisibleMessageHelper`) existem e chegam a tocar o IndexedDB,
  mas exigem um formato de parâmetro interno; `queryChatVisibleMessageHelper`
  chega a devolver erro do próprio IndexedDB ("Invalid key provided").
- `chat.msgs` é um `ChatMsgsCollection` **sem** `findQueryImpl`, então
  `findQuery`/`_serverQuery` não funcionam.
- O histórico **está** no aparelho: 61 mil mensagens no IndexedDB
  `model-storage`, store `message`. Mas o conteúdo é cifrado em repouso
  (`msgRowOpaqueData` + banco `wawc_db_enc`), então ler dali dá metadado, não
  texto.

Consequência prática: **só a captura ao vivo é confiável**. O que o monitor
perde enquanto está fora do ar não é recuperável. Uptime virou o requisito
central.

Em 17/08/2026 as tentativas saíram do caminho de boot: o `BackfillCollector` lê
o que já está em memória (`getAllMessagesInChat`) e mais nada. O `HistoryLoader`
(`src/util/history.ts`) foi removido junto com a "paginação manual" — as três
rotas custavam um erro no log por grupo a cada boot e nunca trouxeram uma
mensagem. O aviso que ficou é o que importa para quem opera: se a mensagem mais
antiga em memória for **posterior** à última registrada no checkpoint, o log traz
`lacuna: o store não alcança a última mensagem registrada`, com os dois horários
— é o intervalo que ninguém viu. Se o WhatsApp mudar de novo, o ponto de partida
é `npm run probe-history`, não escrever rota nova dentro do coletor.

**O sufixo das coleções é só `.env`.** `MONGO_COLLECTION_SUFFIX` vazio grava em
`people`/`groups` (produção); com valor, num conjunto à parte (`people_teste`).
Não há caminho de código que decida isso — todo nome passa por `store.name()`.
Migrar o que já foi capturado de um conjunto para o outro é `mongo:migrate`, e
ele **replica evento, não documento**: `people` é um documento por pessoa
somando todos os grupos dela, e a parte vinda dos grupos que ficam para trás não
teria como ser subtraída depois. O script remonta o log bruto dos grupos
escolhidos num JSONL e passa pelo `Ingestor` normal. `message_read` e
`group_snapshot` não estão no log bruto (ver `writeRawLog`) e são reconstruídos
de `message_reads` e de `people.groups[]` — sem o segundo, o destino fica sem
`participants[]`, `memberCount` e `admins`.

**Nem todo documento de `people` é uma pessoa observada.** A importação de
planilha (repositório `tabatech_monitor`) cria documentos com
`origin: 'external'` para números que nunca apareceram em grupo. Todo estágio
que varre `people` inteira precisa excluí-los — hoje `finalizePeople` e
`scoreAndTier`, via `OBSERVED_ONLY` de `schema.ts`. **Estágio novo que use
`people.find({})` sem esse filtro carimba `tier: 'lurker'` em registro de
planilha e estraga qualquer contagem de silenciosos.** O caminho quente grava
`origin: 'whatsapp'` em `$set` (não `$setOnInsert`): quando a pessoa aparece de
verdade, o mesmo documento é adotado e os campos da planilha sobrevivem.

**A fusão de identidade só soma o que está em `newPersonCounters()`.** O laço de
`drainPerson` tinha uma allowlist implícita perigosa — "todo campo numérico" —
que somaria colunas numéricas de planilha em vez de preservá-las. Contador novo
precisa entrar em `newPersonCounters()` para ser somado numa fusão.

**`eventId` não é chave.** É um UUID novo a cada emissão. Toda chave no Mongo é
derivada do conteúdo, e é isso que permite reimportar o JSONL sem duplicar. Se
você acrescentar uma coleção, dê a ela um `_id` determinístico.

**Contador só incrementa em documento novo.** No caminho quente, `$inc` só
acontece para documentos que o `bulkWrite` acabou de criar (via `upsertedIds`).
Não troque isso por um `$inc` incondicional: o backfill reprocessa mensagens já
vistas, e a conta dobraria.

**Ordem de chegada.** O backfill lê o histórico fora de ordem, então uma reação
frequentemente chega antes da mensagem que ela reage. Por isso o que a pessoa
*recebeu* (reações, respostas, menções) é somado no recálculo, nunca no caminho
quente.

**Chamadas que falham em silêncio.** `getGroupInfo` costuma devolver
`subject`/`description`/`owner` nulos. `getGroupMembers` pode devolver lista
vazia logo após o boot num grupo grande — daí a espera com backoff em
`roster.groupMembers(id, true)`. Um `group_snapshot` com `participantCount: 0`
não significa grupo vazio, e nunca deve sobrescrever a lista conhecida.

**Lista de participantes truncada é pior que lista vazia.** Quando o
`getGroupParticipantIDs` do WA Web falha (`group members ids is not an array
ERROR: this.$1 is not a function`), o open-wa não propaga erro: devolve a lista
com o tamanho certo e a maioria dos contatos **sem `id`**. Em 17/08/2026 isso
fez um grupo de 813 pessoas render 723 `participants_changed` de saída num boot
só — quem perdeu o id some da comparação e a reconciliação lê como êxodo. As
três defesas, todas necessárias: `roster.fetchMembers` descarta a lista inteira
se qualquer contato vier sem id; `roster.groupMembers` devolve a última lista boa
(`lastGoodMembers`, sem TTL) em vez de uma vazia; e `checkpoint.diffParticipants`
ignora ids vazios e não reporta diferença nenhuma para lista vazia. Regra geral:
**redução súbita de participantes é falha de sincronização até prova em
contrário** — o WhatsApp não avisa quando entrega metadado pela metade.

## Nunca versionar

- `data/` — contém as credenciais da sessão do WhatsApp (`*.data.json`) e todo
  o conteúdo capturado dos grupos. Vazar equivale a entregar acesso à conta.
- `.env` — contém a URI do MongoDB com usuário e senha.

Ambos já estão no `.gitignore`. Ao mexer nele, não os remova.
