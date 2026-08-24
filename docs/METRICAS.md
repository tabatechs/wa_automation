# Dicionário de dados e métricas

O que existe no MongoDB, o que cada campo significa, de onde ele sai e para que
serve na pergunta que move o projeto: **quais apoiadores estão engajados a ponto
de valer um convite para outra atividade de mobilização.**

Público: quem for consultar o banco (Compass, Atlas, script de análise) e quem
for mexer no código das métricas.

---

## Antes de tudo: três coisas que mudam a leitura

**1. Nem todo campo nasce ao mesmo tempo.** Há dois caminhos de escrita:

| caminho | quando roda | o que faz |
|---|---|---|
| **quente** (`src/mongo/ingest.ts`) | a cada evento capturado, em lote de ~2 s | contadores simples: `+1` em `messagesSent`, `totalMessages`, `activity_daily` |
| **frio** (`src/mongo/metrics.ts`) | a cada 5 min (`METRICS_REFRESH_MS`) e no `npm run mongo:build` | tudo que precisa varrer o banco: taxas, distintos, sequências, rankings, score |

Na tabela de cada campo, a coluna **origem** diz qual dos dois o preenche. Um
campo frio recém-criado fica ausente (não zero) até a primeira passada —
`$inc` cria o campo sozinho, `$setOnInsert` no mesmo caminho seria conflito.

**2. Todo horário é São Paulo, mas o Compass mostra UTC.** O `Date` do BSON
guarda instante, não fuso. `lastMessageAt` aparece três horas à frente na
interface do Atlas. Por isso existem os espelhos `*Local` (`lastMessageAtLocal`,
`lastEventAtLocal`): **filtre e ordene pelos `Date`, leia os `Local`.** As
chaves de dia (`activity_daily.date`, `YYYY-MM-DD`) e os histogramas de hora já
são de São Paulo — do contrário a conversa das 21h cairia no dia seguinte.

**3. `_id` é sempre derivado do conteúdo, nunca do `eventId`.** O `eventId` é um
UUID novo a cada emissão. Como toda chave sai do conteúdo, reimportar o JSONL
inteiro é idempotente: os contadores não se mexem.

---

## As coleções

| coleção | um documento é | `_id` | papel |
|---|---|---|---|
| **`people`** | uma pessoa | `5511988812345` ou `lid:1993724658` | **leitura principal** — quem convidar |
| **`groups`** | um grupo | `120363...@g.us` | **leitura principal** — saúde do grupo |
| `activity_daily` | um dia de um grupo (ou de uma pessoa num grupo) | `grupo\|pessoa\|2026-08-17` | série temporal |
| `messages` | uma mensagem | `messageId` do WhatsApp | matéria-prima + rollups |
| `reactions` | uma reação | `msg\|ator\|emoji` | estado atual (`active`) |
| `message_reads` | alguém abriu uma mensagem sua | `msg\|ator` | só mensagens `fromMe` |
| `member_events` | entrada, saída, promoção | hash de `(grupo, ação, quem, quando)` | histórico de composição |
| `poll_votes` | um voto em enquete | `enquete\|pessoa` | **sempre vazia** — ver §7 |
| `events` | cópia fiel do evento do JSONL | id do fato + tipo | log bruto, se `MONGO_RAW_LOG=true` |

Os nomes acima são os lógicos. `MONGO_COLLECTION_SUFFIX` no `.env` acrescenta o
sufixo real (`people_teste`); vazio = produção.

---

## 1. `people` — a coleção que responde "quem convidar"

### 1.1 Identidade

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `_id` | chave da pessoa | dígitos do E.164 (`5511988812345`); enquanto o número não aparece, `lid:<id>` provisório | o telefone é o que permite convidar de fato |
| `phone` | número em E.164 | do contato ou da ponte LID→`@c.us` | canal de contato |
| `ddd` | 2 dígitos do DDD | só para números `+55`; `null` no resto | convite para evento regional |
| `isInternational` | não é `+55` | prefixo diferente de `55` | códigos de país têm 1 a 3 dígitos e não dá para separar sem tabela — então nem se tenta |
| `isMobile` | celular | assinante com 9 dígitos começando em 9 | `null` para internacional |
| `name` | nome exibido | primeiro campo não vazio na precedência de `nameSource` | é o que aparece no ranking |
| `nameSource` | qual campo do contato deu o nome | precedência: `contact` → `formattedName` → `pushname` → `shortName`; número puro é descartado, porque o WhatsApp devolve o próprio número como "nome" quando não há contato salvo | um `pushname` (o que a pessoa escolheu exibir) é menos confiável que o nome salvo na agenda |
| `aliases[]` | todos os ids do WhatsApp já vistos | `@lid` (mensagens/reações) e `@c.us` (lista de participantes) | é o que impede a mesma pessoa virar dois documentos |
| `mergedFrom[]` | `_id`s provisórios absorvidos | escrito na fusão de identidade | auditoria: dá para saber que este documento comeu um `lid:` |
| `origin` | `whatsapp` (observada) ou `external` (registro de planilha) | o monitor grava `whatsapp` em **todo** evento que toca a pessoa; `external` só é escrito por ferramenta externa. **Ausente = observada** (documentos anteriores a 22/08/2026) | ver o quadro abaixo |

> **Registros externos.** O painel de planilhas cria documentos em `people`
> para números que ainda não apareceram em grupo nenhum — existem para ser
> pesquisáveis. Eles levam `origin: 'external'` e **ficam fora de todo cálculo**:
> `finalizePeople` e `scoreAndTier` filtram por `origin: {$ne: 'external'}`, de
> modo que esses documentos nunca recebem `tier`, `engagementScore` nem os
> sinalizadores. As métricas de grupo já os ignoravam por construção — sem
> `groups[]`, ninguém entra em `memberCount`, `participationRate`,
> `silentMemberCount` ou `dddDistribution` — e a base do percentil sempre exigiu
> ≥1 mensagem ou ≥1 reação.
>
> Quando a pessoa **finalmente aparece** num grupo, o monitor faz upsert no mesmo
> `_id` (o telefone) e grava `origin: 'whatsapp'` via `$set`. Não vira documento
> duplicado: o mesmo documento passa a ser observado e **os campos da planilha
> continuam ali**. É por isso que `origin` está em `$set` e não em
> `$setOnInsert` — com `$setOnInsert` o marcador de planilha sobreviveria ao
> primeiro contato e a pessoa ficaria fora das métricas para sempre.

> **A armadilha da identidade.** O WhatsApp entrega a mesma pessoa como `@lid`
> quando ela fala e como `@c.us` quando aparece na lista de membros — e o LID
> ainda pode vir com sufixo de dispositivo (`...:71@lid`). Sem a unificação por
> telefone, cada apoiador vira dois ou três documentos e **toda** métrica se
> divide. Quem tem `_id` começando em `lid:` é alguém que ainda não teve o
> número resolvido; o recálculo funde assim que ele aparece.

### 1.2 Participação em grupos

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `groups[]` | um item por grupo: `{groupId, active, isAdmin, joinedAt, leftAt, messagesSent, reactionsGiven, lastMessageAt}` | vínculo criado no caminho quente; `messagesSent`/`reactionsGiven` por grupo vêm de `activity_daily` no recálculo | separa "fala muito, mas só num grupo" de "ativa em toda parte" |
| `groupCount` | tamanho de `groups[]` | frio | alcance total |
| `activeGroupCount` | quantos com `active: true` | frio | quem saiu não conta |
| `isMultiGroup` | está ativa em >1 grupo | `activeGroupCount > 1` | multiplicador natural: já circula entre círculos |
| `isAdminSomewhere` | é admin em algum grupo | qualquer `groups[].isAdmin` | quem já organiza é o convite mais barato |

Uma mensagem antiga trazida pelo backfill **não reativa** um vínculo: quem
decide `active` é evento de entrada/saída ou o snapshot do grupo.

### 1.3 Volume — quanto a pessoa fala

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `messagesSent` | mensagens enviadas | quente: `+1` por mensagem. `--full` reconta de `messages`. **Só conta fala** — ver §4.1 | a métrica bruta de participação |
| `mediaSent` | mensagens com mídia | `isMedia` | quem manda foto/vídeo costuma estar em campo |
| `charsSent` | caracteres somados | `body` ou `caption` | separa quem argumenta de quem manda "👍" |
| `avgMessageLength` | média de caracteres | frio, `$avg` do `len` das mensagens | idem, já normalizado |
| `linksShared` | links compartilhados | contagem de URLs no texto | difusão de conteúdo — quem espalha material da campanha |

### 1.4 Conversa — quanto a pessoa interage com gente

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `repliesSent` | citou alguém | mensagens com `quotedMsgId` | falar *com* alguém ≠ falar no vazio |
| `repliesReceived` | foi citada | frio: soma de `messages.repliesCount` das mensagens dela | o que ela diz puxa conversa |
| `mentionsMade` | @ que ela fez | tamanho de `mentionedIds` | mobiliza outras pessoas nominalmente |
| `mentionsReceived` | @ que ela recebeu | frio: `mentionedIds` cruzado com `people.aliases` | é procurada — sinal de referência no grupo |
| `repliesReceivedPerMessage` | respostas por mensagem | `repliesReceived / messagesSent` | ressonância normalizada pelo volume |

### 1.5 Reações

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `reactionsGiven` | reações que deu | quente, `+1`/`-1` (remover reação decrementa) | engajamento de baixo custo — o primeiro sinal de quem está lendo |
| `reactionsReceived` | reações que recebeu | frio: soma de `messages.reactionsCount` das mensagens dela | aprovação do grupo |
| `messagesWithReaction` | mensagens dela que receberam ≥1 reação | frio | diferente de `reactionsReceived`: uma mensagem com 30 reações não é o mesmo que 30 mensagens com 1 |
| `reactionsReceivedPerMessage` | reações por mensagem | `reactionsReceived / messagesSent` | **a métrica de influência**: quem fala pouco e repercute muito |
| `distinctPeopleWhoReacted` | quantas pessoas diferentes reagiram a ela | frio, `$addToSet` sobre reações ativas | alcance na rede, não volume: 20 reações de 20 pessoas ≠ 20 de uma |
| `distinctPeopleReactedTo` | a quantas pessoas diferentes ela reagiu | idem, pelo outro lado | quem distribui atenção pelo grupo, não só ao mesmo amigo |
| `emojisUsed[]` | emojis distintos usados | `$addToSet` no caminho quente | matéria-prima; leitura qualitativa |
| `topEmojis[]` | ⚠️ **hoje só o emoji, `count` sempre 0** | primeiros 10 de `emojisUsed` | ver §8 |

### 1.6 Leitura

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `messagesRead` | quantas mensagens **suas** esta pessoa abriu | um registro por pessoa por mensagem em `message_reads` | presença silenciosa: quem lê tudo e nunca escreve **existe** e é alcançável |

> O WhatsApp entrega confirmação de leitura só a quem enviou. Isso vale
> exclusivamente para as mensagens da própria conta conectada (`fromMe`) —
> não há como saber quem leu a mensagem de um terceiro. Em grupo onde você
> nunca postou, este campo é 0 para todo mundo, e isso não significa nada.
> Ler alimenta `lastSeenAt`, **nunca** `lastMessageAt`: contaminar o segundo
> estragaria o corte de "não fala há X dias".

### 1.7 Ritmo — regularidade, que vale mais que pico

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `activeDays` | dias distintos em que falou | frio, `$addToSet` da data (São Paulo) das mensagens | constância |
| `activeDaysLast30` | idem, últimos 30 dias | mesmo cálculo com corte | **é a dimensão de consistência do score** |
| `currentStreakDays` | sequência de dias consecutivos ativa **agora** | percorre as datas ordenadas; só conta se a última for hoje ou ontem | quem está na rotina do grupo neste momento |
| `longestStreakDays` | maior sequência já feita | idem, sem corte | histórico de comprometimento |
| `tenureDays` | dias desde o primeiro sinal | `firstSeenAt` até hoje | veterana ou recém-chegada |
| `daysSinceLastMessage` | dias desde a última mensagem | `lastMessageAt` até hoje; `null` se nunca falou | o filtro mais direto de "ainda está aqui?" |
| `messagesPerActiveDay` | intensidade nos dias em que aparece | `messagesSent / activeDays` | separa quem conversa de quem despeja |
| `hourHistogram` | `{"20": 34, "21": 12}` | `+1` por mensagem na hora local | quando essa pessoa está disponível |
| `weekdayHistogram` | `{"0": 5, ...}` — domingo = 0 | idem | fim de semana × dia útil, útil para escolher a data do convite |
| `firstSeenAt` / `lastSeenAt` | qualquer sinal (mensagem, reação, leitura, entrada) | `$min` / `$max` no caminho quente | presença, incluindo quem só reage |
| `lastMessageAt` | última **fala** | `$max` do `sentAt` | não confundir com `lastSeenAt` |

> Histogramas são objeto, não array. `$inc` em `hourHistogram.14` cria a chave
> sozinho; inicializar 24 zeros no mesmo update daria conflito de caminho no
> Mongo. **Chave ausente vale zero.**

### 1.8 Tendência

| campo | o que é | como é calculado | por que importa |
|---|---|---|---|
| `messagesLast7d` | mensagens nos últimos 7 dias | frio, corte por data | atividade atual |
| `messagesPrev7d` | mensagens nos 7 dias anteriores | idem | base de comparação |
| `trend7d` | `rising` / `stable` / `falling` | variação relativa ≥ +20% sobe, ≤ −20% cai (`SCORING.trendThreshold`) | **quem está esquentando agora vale mais que quem foi campeão há seis meses** |

### 1.9 Sinalizadores de mobilização

| campo | regra exata | leitura |
|---|---|---|
| `isLurker` | `messagesSent === 0` e está em ≥1 grupo ativo | nunca falou. Invisível em qualquer contagem por mensagem, mas continua alcançável — e é a maior fatia do banco |
| `isObserver` | `messagesSent ≤ 3` **e** `reactionsGiven > 0` | quase não escreve, mas reage. Engajamento real que o volume não enxerga — o convite mais subestimado |
| `isDormant` | já falou e `daysSinceLastMessage > 30` | era ativa e sumiu. Candidata a reativação, não a convite de liderança |
| `isAdminSomewhere` | algum `groups[].isAdmin` | já organiza |
| `isMultiGroup` | ativa em >1 grupo | circula |

### 1.10 Score e faixa

`engagementScore` (0–100) é a **média ponderada de quatro percentis**:

| dimensão | peso | valor usado |
|---|---|---|
| volume | 35% | `messagesSent` |
| consistência | 30% | `activeDaysLast30` |
| ressonância | 20% | `(reactionsReceived + repliesReceived) / messagesSent` |
| recência | 15% | `−daysSinceLastMessage` (invertido: falar ontem vale mais) |

Pesos e cortes ficam em `src/mongo/scoring.ts`. Mexeu, rode `npm run mongo:build`.

**Por que percentil e não valor absoluto:** 40 mensagens num grupo de 20 pessoas
não é a mesma coisa que 40 num de 800. Assim `90` significa sempre "está entre
os 10% mais engajados". Empates recebem o mesmo percentil.

**A base do percentil é só quem participa** — quem já mandou ≥1 mensagem *ou*
deu ≥1 reação. Num grupo de 830 pessoas em que 825 nunca falaram, incluir todo
mundo faria o score responder apenas "você não é silencioso": uma única mensagem
saltaria para o percentil 99 e as pessoas ativas ficariam indistinguíveis.
Quem não participa recebe `engagementScore: 0` e é separado pelo `tier`.

`tier` — **os estados são checados antes do score, nesta ordem**:

| faixa | regra | o que fazer com ela |
|---|---|---|
| `lurker` | `isLurker` | está no grupo e nunca falou — alcançável, mas frio |
| `dormant` | `isDormant` | era ativa e sumiu há >30 dias — reativar, não promover |
| `observer` | `isObserver` | reage e quase não escreve — testar com convite pequeno |
| `champion` | score ≥ 90 | **a lista de convite** |
| `active` | score ≥ 65 | segunda leva |
| `occasional` | o resto | base ampla |

A ordem importa: quem foi campeão e sumiu há dois meses não é um bom convite
hoje; quem nunca escreveu mas reage em tudo pode ser.

---

## 2. `groups` — a saúde de cada grupo

### 2.1 Identidade e membros

| campo | o que é | como é calculado |
|---|---|---|
| `_id`, `subject`, `description`, `owner` | id e metadados do grupo | do snapshot; `getGroupInfo` costuma devolver nulos, então podem ficar vazios |
| `label` | ⚠️ legado, **sempre `null`** | a whitelist saiu para o `.env` e hoje guarda só ids |
| `participants[]` | `{personId, name, isAdmin, active}` | frio: reconstruído das pessoas com vínculo ativo neste grupo |
| `memberCount` | tamanho de `participants[]` | frio |
| `admins[]` | `personId` dos admins | frio |
| `joins` / `leaves` | entradas e saídas acumuladas | quente, por `participants_changed` |

> **Redução súbita de `memberCount` é falha de sincronização até prova em
> contrário.** Quando o WA Web entrega a lista de participantes pela metade, o
> open-wa não sinaliza erro — devolve a lista com o tamanho certo e os contatos
> sem `id`. Um `participantCount: 0` não significa grupo vazio.

### 2.2 Volume

| campo | o que é | como é calculado |
|---|---|---|
| `totalMessages` | mensagens do grupo | quente; frio reconta de `messages` |
| `totalReactions` | reações dadas no grupo | quente, `+1`/`-1` |
| `mediaMessages` | mensagens com mídia | idem |
| `messagesWithReaction` | mensagens que receberam ≥1 reação | frio |
| `messagesWithReply` | mensagens que foram citadas | frio |
| `totalReads` | leituras de mensagens próprias | 0 em grupo onde você não posta — não é sinal de nada |
| `totalPolls` | ⚠️ **sempre 0 hoje** | ver §8 |

### 2.3 Participação — a métrica que separa grupo grande de grupo vivo

| campo | fórmula | leitura |
|---|---|---|
| `activeMembers7d` | autores distintos nos últimos 7 dias | quem falou esta semana |
| `activeMembers30d` | autores distintos nos últimos 30 dias | base ativa |
| `participationRate` | `activeMembers30d / memberCount` | **a diferença entre "800 pessoas" e "800 pessoas conversando"** |
| `silentMemberCount` | `memberCount − autores de todos os tempos` | o estoque de gente nunca ativada |

### 2.4 Taxas de interação

| campo | fórmula | leitura |
|---|---|---|
| `reactionRate` | `messagesWithReaction / totalMessages` | **quanto do que se diz é reagido** |
| `avgReactionsPerMessage` | soma de `reactionsCount` ÷ `totalMessages` | intensidade da reação |
| `replyRate` | `messagesWithReply / totalMessages` | **quanto vira conversa** em vez de monólogo paralelo |
| `mediaShare` | `mediaMessages / totalMessages` | grupo de troca de material × grupo de debate |
| `pollResponseRate` | ⚠️ **sempre `null`** | ver §7 |

Todas as taxas são arredondadas em 3 casas.

### 2.5 Concentração — o grupo é conversa ou palanque?

| campo | como é calculado | leitura |
|---|---|---|
| `top10SharePct` | % das mensagens vindas dos 10% mais ativos (mínimo 1 pessoa) | 80% aqui significa que o grupo é um punhado de gente falando e o resto assistindo |
| `giniMessages` | Gini sobre as mensagens por autor: 0 = todo mundo fala igual, 1 = uma pessoa fala tudo | mesma pergunta, escala contínua |
| `topPosters[]` | 10 maiores por mensagens | quem fala mais |
| `topReactors[]` | 10 maiores por reações ativas dadas | quem sustenta o clima |
| `topReceivers[]` | 10 maiores por reações **recebidas** | **quem tem voz** — nem sempre é quem mais fala, e é a lista mais interessante para liderança |

### 2.6 Ritmo e saúde

| campo | o que é |
|---|---|
| `hourHistogram` / `weekdayHistogram` | mesma lógica de `people` |
| `peakHours[]` | as 3 horas com mais mensagens, em ordem crescente — **quando mandar o convite** |
| `dddDistribution` | `{"11": 340, "21": 88, "internacional": 4, "desconhecido": 9}`, contando membros ativos — orienta evento regional |
| `messagesLast7d`, `messagesPrev7d`, `trend7d` | mesma regra de ±20% de `people` — grupo esfriando aparece aqui antes de esvaziar |
| `daysSinceLastMessage` | dias desde a última fala |
| `lastMessageAt` | do `sentAt` da mensagem |
| `lastEventAt` | qualquer evento, inclusive os que só têm horário de captura (reação, leitura, mudança de participante) |
| `netGrowth30d`, `churnRate30d` | ⚠️ **não preenchidos** — ver §8 |

---

## 3. `activity_daily` — a série temporal

Um documento por `(grupo, pessoa, dia)`. Com `personId: null`, é a **linha
agregada do grupo** naquele dia.

```
_id: "120363...@g.us|5511988812345|2026-08-17"
_id: "120363...@g.us|_all|2026-08-17"          ← linha do grupo
```

| campo | o que é |
|---|---|
| `messages`, `mediaMessages`, `chars`, `repliesSent` | do dia, reconstruídos de `messages` |
| `reactionsGiven` | de `reactions` ativas, pela data de `addedAt` |
| `messagesRead` | de `message_reads`, pela data de `readAt` |
| `activeMembers` | só na linha do grupo: autores distintos no dia |

Esta coleção existe para não inflar `groups` com histórico — um documento do
Mongo tem teto de 16 MB e a série cresce sem fim. É daqui que saem curvas de
mensagens/dia, retenção e qualquer recorte temporal.

**Verificação útil:** a soma de `messages` das linhas `_all` de um grupo tem que
bater com `groups.totalMessages`. Se não bate, há linha órfã de uma fusão de
identidade (o recálculo apaga essas linhas, porque o `personId` está no `_id` e
não há como repontá-lo).

---

## 4. `messages`

| campo | nota |
|---|---|
| `_id` | o `messageId` do WhatsApp, ~80 caracteres, já embute grupo e autor |
| `authorId` | o `personId` resolvido. **Só escrito na inserção** (`$setOnInsert`): reprocessar não pode desfazer uma fusão de identidade |
| `body`, `caption`, `len`, `wordCount`, `linkCount` | conteúdo completo |
| `isMedia`, `mimetype`, `messageType` | tipo |
| `fromMe` | mensagem da conta conectada — é o que habilita `message_reads` |
| `backfill` | veio do histórico em memória, não ao vivo |
| `quotedMsgId` | mensagem citada; índice **esparso**, porque a maioria não cita ninguém |
| `mentionedIds[]` | ids do WhatsApp, não `personId` — o cruzamento é por `aliases` |
| `hour`, `weekday` | já em São Paulo |
| `isPoll`, `pollOptions` | criação de enquete é legível; os votos não (§7) |
| `reactionsCount`, `distinctReactors`, `repliesCount`, `readsCount` | **rollups**, recontados da fonte no recálculo — nunca escritos pelo evento |

> **Por que os rollups são recontados e não incrementados:** o backfill lê o
> histórico fora de ordem, então uma reação chega com frequência antes da
> mensagem que ela reage. Somar na hora perderia o crédito. Tudo que a pessoa
> *recebeu* é calculado no caminho frio, a partir da fonte.

### 4.1 O que **não** entra em `messages`

`messagesSent` e `totalMessages` contam **fala**, não notificação. O
`onAnyMessage` entrega também os avisos de sistema que o WhatsApp materializa
como objeto de mensagem no chat, e eles são descartados na captura e no
`Ingestor` — a lista e o critério estão em `src/util/messageTypes.ts`.

| tipo | o que é | por que fica fora |
|---|---|---|
| `gp2` | o balão cinza de "Fulano adicionou Beltrano", "Fulano saiu", "Fulano mudou a descrição" | é a **mesma** entrada/saída já registrada em `member_events`, vista pelo lado do chat. Ninguém escreveu nada |
| `notification`, `notification_template`, `e2e_notification`, `broadcast_notification`, `group_notification`, `protocol`, `call_log`, `group-history`, `message_history_notice` | a mesma família | aviso do sistema, nunca tem corpo |
| `ciphertext` | mensagem que não foi decifrada | existiu, mas não temos o conteúdo |
| `revoked` | mensagem apagada por quem escreveu | idem |

Continuam contando: `groups_v4_invite` (é um cartão que alguém enviou de
propósito), `poll_creation` (criar enquete é participar) e `unknown` — este
último é o nosso próprio fallback para `type` ausente, e pode ser mensagem de
verdade. **Na dúvida conta como fala:** perder participação é pior que contar
ruído.

> **Por que isso é uma métrica e não uma faxina.** Sem o filtro, entrar num
> grupo dava `messagesSent += 1`. Em 24/08/2026, em produção, 61 dos 500
> documentos de `messages` eram `gp2` (12%) e **37 das 119 pessoas com
> "mensagem" nunca tinham escrito uma linha** — apareciam como `occasional` ou
> `observer` quando são `lurker`. Do outro lado, inflava os admins: quem
> adiciona gente ganhava uma mensagem por convite. O conserto do que já estava
> gravado é `npm run mongo:fix-messages`, seguido de `mongo:build --full`.

## 5. `reactions`

`_id = ${targetMessageId}|${ator}|${emoji}`. A chave usa o **id normalizado do
ator**, não o `personId` — se usasse o `personId`, a mesma reação viraria dois
documentos quando o telefone fosse resolvido depois, e a contagem dobraria.

`active: false` + `removedAt` é como uma reação removida fica: o documento
permanece, e todo cálculo filtra por `active: true`.

## 6. `message_reads`, `member_events`

`message_reads`: um registro por pessoa por mensagem. Não existe "leitura
removida" — ler é irreversível, então não há o par `active`/`removedAt`.
É o evento de maior cardinalidade do projeto, e por isso fica fora do log bruto.

`member_events`: `action` (`add`/`remove`/`leave`/`promote`/`demote`),
`personId` (quem), `byPersonId` (quem executou), `detectedOnResume` (a mudança
foi inferida na volta do monitor, não vista ao vivo). É o histórico de
composição do grupo — `groups.participants[]` só guarda o estado atual.

---

## 7. Enquetes: por que os campos são sempre nulos

Verificado com sessão real em 13/08/2026. **Os votos não existem para um
aparelho conectado**: são cifrados ponta a ponta e decifrados só no aparelho
principal. No store do WA Web, `__x_pollVotesSnapshot` é `{"pollVotes": []}` e
`Store.PollVote` tem 0 modelos, mesmo com voto emitido ao vivo.

Consequência: `people.pollVotesCast`, `people.pollResponseRate`,
`groups.pollResponseRate` e a coleção `poll_votes` ficam permanentemente
vazios/nulos. **Não é bug e não tem conserto.**

O que continua legível é a **criação** da enquete — autor, pergunta e opções
(`messages.isPoll`, `messages.pollOptions`). Como sinal de mobilização não é
pouco: quem cria enquete costuma ser quem organiza. Falta o coletor que
transforma isso em `pollsCreated` e `totalPolls`.

---

## 8. Campos declarados que ainda não são preenchidos

Honestidade sobre o schema — estes existem na tipagem mas nenhum caminho de
código escreve neles hoje:

| campo | estado | o que falta |
|---|---|---|
| `people.conversationsStarted` | sempre 0 | detectar a primeira mensagem após ≥60 min de silêncio no grupo |
| `people.pollsCreated`, `groups.totalPolls` | sempre 0 | coletor de criação de enquete (§7) — é viável |
| `people.pollVotesCast`, `pollResponseRate`, `groups.pollResponseRate` | 0 / `null` | **impossível** (§7) |
| `people.topEmojis[].count` | sempre 0 | `emojisUsed` é um `$addToSet`, não guarda frequência; precisaria contar de `reactions` |
| `groups.netGrowth30d`, `churnRate30d` | ausentes | somar `member_events` dos últimos 30 dias |
| `groups.label` | sempre `null` | legado da whitelist antiga em `config/groups.json` |

---

## 9. Consultas típicas

```js
// A lista de convite: os mais engajados que ainda estão ativos
db.people.find({ tier: { $in: ['champion', 'active'] }, phone: { $ne: null } })
         .sort({ engagementScore: -1 }).limit(50)

// Quem tem voz sem ser quem mais fala — influência, não volume
db.people.find({ messagesSent: { $gte: 5 } })
         .sort({ reactionsReceivedPerMessage: -1 }).limit(30)

// Observadores: quase não escrevem, mas reagem — o convite subestimado
db.people.find({ isObserver: true }).sort({ reactionsGiven: -1 })

// Quem está esquentando agora
db.people.find({ trend7d: 'rising', messagesLast7d: { $gte: 3 } })
         .sort({ messagesLast7d: -1 })

// Reativação: era ativa e sumiu
db.people.find({ isDormant: true, messagesSent: { $gte: 20 } })
         .sort({ messagesSent: -1 })

// Multiplicadores: circulam entre grupos
db.people.find({ isMultiGroup: true, tier: { $in: ['champion', 'active'] } })

// Silenciosos de um grupo — estoque nunca ativado
db.people.find({ groups: { $elemMatch: { groupId: 'X@g.us', active: true } },
                 messagesSent: 0 })

// Curva diária de um grupo
db.activity_daily.find({ groupId: 'X@g.us', personId: null }).sort({ date: 1 })

// Saúde dos grupos, do mais vivo ao mais parado
db.groups.find({}, { subject: 1, memberCount: 1, participationRate: 1,
                     reactionRate: 1, trend7d: 1, peakHours: 1 })
         .sort({ participationRate: -1 })
```

---

## 10. Como recalcular

```bash
npm run mongo:build          # passada normal: derivados, rankings, score
npm run mongo:build -- --full # reconta TODOS os contadores da fonte
```

`--full` zera e reconstrói `messagesSent`, `reactionsGiven`, `totalMessages`,
histogramas e afins a partir de `messages`/`reactions`/`message_reads`. É a rede
de segurança contra qualquer deriva do caminho incremental, e o que se roda
**depois de mudar a definição de uma métrica** ou os pesos de `scoring.ts`.

A ordem interna da passada não é arbitrária:

1. **fusão de identidades** — `lid:` provisórios que ganharam telefone; reponta
   `messages`/`reactions`/`member_events`, senão o provisório renasce na passada
   seguinte
2. **rollups das mensagens** — `reactionsCount`, `repliesCount`, `readsCount`,
   recontados da fonte (resolve a reação que chegou antes da mensagem)
3. **série diária** — reescrita, o que absorve as fusões do passo 1
4. `--full`: recontagem dos contadores brutos + histogramas
5. **derivados de `people`** → 6. **derivados de `groups`** → 7. **score e tier**

O score é o último porque depende de tudo que veio antes.

### O que `--full` **não** conserta

Nem todo campo é derivado de um fato. Estes só existem como acumulador do
caminho quente, e nenhuma passada os recalcula:

| campo | quem conserta |
|---|---|
| `groups.joins`, `groups.leaves` | `npm run mongo:fix-members` |
| `people.lastMessageAt`, `groups.lastMessageAt` (`$max` do caminho quente) | `npm run mongo:fix-messages` |

É por isso que os dois scripts de conserto existem: apagar o documento errado
não basta se o contador que ele somou não for desfeito à mão.

---

## 11. O que este banco não sabe

- **Só a captura ao vivo é confiável.** O WA Web não entrega histórico nesta
  build (investigado em 14/08/2026); `getAllMessagesInChat` devolve apenas o que
  está na memória da página — numa conversa de centenas de mensagens, costuma
  ser uma dúzia. **O que o monitor perde enquanto está fora do ar não é
  recuperável.** Uptime é o requisito central.
- Só grupos da whitelist `MONITORED_GROUPS` são gravados. Nada fora dela existe
  aqui.
- Quem entrou e saiu antes do monitor subir pode não ter documento nenhum.
- Conteúdo apagado depois da captura permanece — o monitor não vê a exclusão.
- Nenhuma métrica mede intenção. `engagementScore` mede comportamento observável
  num grupo de WhatsApp; a decisão de convidar é de quem lê.
