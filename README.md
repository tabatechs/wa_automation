# wa_automation — monitor de grupos do WhatsApp

Conecta um celular via [`@open-wa/wa-automate`](https://github.com/open-wa/wa-automate-nodejs) e registra, num arquivo local, tudo que acontece nos grupos que você escolher: **mensagens**, **entradas/saídas/promoções de participantes** e **reações**.

**Somente leitura.** O serviço nunca envia mensagens nem executa ações de escrita nos grupos.

---

## Requisitos

- Node.js **20 LTS ou 22**
- Um celular com WhatsApp para parear (fica como *aparelho conectado*)

## Instalação

```bash
npm install
cp .env.example .env
```

## Primeiro uso

**1. Descubra o id do grupo**

```bash
npm run list-groups
```

Um QR code é desenhado **no terminal** (o processo roda headless, sem janela do Chromium). No celular: **Configurações → Aparelhos conectados → Conectar um aparelho**. Depois de parear, o script imprime uma linha por grupo — `nº de participantes`, `id` e nome — e marca com `*` os que já estão sendo monitorados.

Numa conta com muitos grupos a lista não cabe na tela, então ela é gravada também em `data/grupos.txt` e `data/grupos.json` (esse diretório não vai para o repositório). Para achar um grupo específico sem rolar nada, filtre pelo nome:

```bash
npm run list-groups -- apoio
```

Com filtro, o script ainda imprime a linha pronta para colar no `.env`.

> Se preferir ver o navegador — para depurar o que a página está fazendo — rode com `HEADLESS=false`. Aí o QR aparece tanto na janela do Chromium quanto no terminal.

**2. Configure a whitelist**

A whitelist é a variável `MONITORED_GROUPS`, no `.env` — só ids, separados por vírgula ou quebra de linha:

```bash
MONITORED_GROUPS="120363000000000000@g.us,
120363000000000001@g.us"
```

Sem apelido: o nome do grupo é lido do WhatsApp em execução. Um `#` no começo da entrada desliga aquele grupo sem apagar o id. Um id que não termine em `@g.us` interrompe o boot com a linha errada apontada — melhor parar do que monitorar menos do que se pensava.

> Por que no `.env` e não num arquivo do projeto: id de grupo aponta para pessoas reais, e o `.env` não é versionado. O antigo `config/groups.json` foi removido.

**3. Rode o monitor**

```bash
npm run dev
```

Os eventos começam a cair em `data/events.jsonl`. Da segunda vez em diante não há QR — a sessão fica salva em `data/session/`.

---

## Saída

Um evento JSON por linha (JSON Lines) em `data/events.jsonl`:

```json
{
  "schema": 1,
  "eventId": "8f3c…",
  "type": "message",
  "capturedAt": "2026-08-11T11:03:22.114-03:00",
  "group": { "id": "1203…@g.us", "name": "Meu grupo" },
  "actor": {
    "id": "5511999998888@c.us",
    "phone": "+5511999998888",
    "name": "João",
    "nameSource": "contact"
  },
  "payload": { "messageId": "…", "body": "olá", "messageType": "chat", "…": "…" }
}
```

| `type` | quando ocorre |
|---|---|
| `message` | mensagem no grupo (inclui as suas) |
| `reaction_added` / `reaction_removed` | alguém reagiu / desfez a reação |
| `participants_changed` | entrada, saída, promoção ou rebaixamento |
| `group_snapshot` | estado completo do grupo (no boot e a cada mudança de participantes) |
| `session_state` | transições de conexão |

`actor.id` é a chave canônica — use sempre ele para deduplicar. `name` pode ser `null` (contato sem nome salvo) e `nameSource` indica de qual campo do WhatsApp o nome veio.

**Horários.** Todo carimbo é ISO 8601 no fuso de São Paulo, com o deslocamento explícito (`…-03:00`), e não em UTC: o dado é lido por gente que trabalha nesse fuso, e "21:05Z" para uma mensagem das 18:05 vira atrito em toda conferência manual. O instante é o mesmo que um `…Z` representaria, então `new Date(...)`, o Mongo e qualquer parser de ISO 8601 continuam funcionando — inclusive sobre os eventos gravados em UTC antes de 17/08/2026, que continuam válidos e não precisam de conversão. As séries diárias e o histograma por hora também usam São Paulo, então "pico às 20h" é 20h aqui. Para mudar de fuso, é a constante `TIMEZONE` em `src/util/time.ts`.

No MongoDB, os campos de data são `Date` do BSON, que guarda o instante e não carrega fuso — o Compass e o Atlas costumam mostrá-los em UTC. As chaves de dia (`activity_daily`) e os histogramas, esses sim, já são de São Paulo.

**Precisa de um `.json` normal?**

```bash
npm run compact   # gera data/events.json com um array
```

JSON Lines é o formato de gravação porque o append é atômico e barato: um array único exigiria reescrever o arquivo inteiro a cada evento, e um crash no meio deixaria o JSON corrompido.

---

## Histórico e retomada

No boot, antes de escutar ao vivo, o monitor varre os últimos `BACKFILL_DAYS` dias (7 por padrão) de cada grupo e emite **apenas o que ainda não foi registrado**.

A janela é sempre a mesma, mesmo já havendo checkpoint. Fazê-la começar na última mensagem registrada parecia economia, mas amarrava a cobertura ao que já tinha sido capturado: se uma execução falhasse em ler parte do histórico, o checkpoint avançava assim mesmo e aquele trecho ficava inalcançável para sempre. Reler é barato, e a deduplicação por `messageId` garante que nada saia duas vezes.

Mensagens recuperadas assim vêm com `"backfill": true` no payload, para você distinguir captura retroativa de tempo real.

**Participantes** também são reconciliados: a lista atual é comparada com a do checkpoint, e quem entrou ou saiu com o monitor desligado vira um `participants_changed` com `"detectedOnResume": true`. Nesses eventos `actor` é `null` e não há horário exato — o WhatsApp não guarda esse rastro para quem não estava escutando.

O estado fica em `data/state/checkpoint.json`.

> **"Todo o histórico" não existe no multi-device.** O WhatsApp só sincroniza uma janela de histórico para aparelhos conectados. O backfill vai até onde o WhatsApp entregou e para — não há como recuperar o grupo inteiro desde a criação. Mensagens que você apagou do celular também não voltam: apagar histórico é irreversível e propaga para os aparelhos conectados.

---

## Como as reações são capturadas

Na v4 do open-wa o listener nativo `onReaction` exige licença paga (`insiders`). Mas o objeto `Message` já carrega o array `reactions[]` com quem reagiu e com qual emoji, e `getAllMessagesInChat` é livre.

Então um worker relê as mensagens da janela recente a cada `REACTION_POLL_MS` (30 s por padrão) — **uma** chamada por grupo, não uma por mensagem — e compara com o estado anterior para derivar `reaction_added` / `reaction_removed`. O estado fica em `data/state/reactions.json`, então reiniciar o processo não reemite reações antigas.

Duas consequências a conhecer:

- Reações aparecem com atraso de até um ciclo de polling (~30 s), não em tempo real.
- Só mensagens dentro da janela de observação (`REACTION_WINDOW_SIZE` / `REACTION_WINDOW_HOURS`) têm reações monitoradas. A janela nunca é mais estreita que `BACKFILL_DAYS`, para que mensagens recuperadas do histórico também sejam cobertas.

---

## Quem leu as mensagens que você enviou

O WhatsApp só entrega confirmação de leitura a **quem enviou**. Não existe forma de saber quem leu a mensagem de outra pessoa — nem pela API, nem pelo store, nem no aplicativo. Então este recurso cobre exatamente um caso: as mensagens que **você** escreve à mão pelo celular nos grupos monitorados. O monitor continua sem enviar nada.

Dentro desse escopo o sinal é forte, porque **em grupo a confirmação de leitura é sempre enviada**, independentemente da configuração de privacidade de quem lê (ao contrário da conversa individual). Quem abre suas mensagens e nunca responde é justamente o apoiador que os outros indicadores não enxergam.

Como funciona: cada mensagem própria entra numa lista de vigiadas e, a cada `READ_RECEIPT_POLL_MS`, o monitor lê os "dados da mensagem" — a mesma informação da tela de mesmo nome no WhatsApp Web. Cada leitor inédito vira um evento `message_read`. O estado fica em `data/state/read-receipts.json`, então reiniciar não reemite leituras antigas. A mensagem sai da vigilância quando todo mundo já leu ou quando passa de `READ_RECEIPT_WINDOW_HOURS`.

Três coisas a conhecer:

- **O custo é por mensagem**, não por grupo como nas reações — daí o teto `READ_RECEIPT_MAX_PER_CYCLE` e o intervalo folgado de 15 min. O número de eventos é o mesmo em qualquer cadência (um por pessoa por mensagem, uma vez só); varrer mais rápido não descobre mais gente, só gasta mais consulta na sessão. E o horário gravado é o do WhatsApp, não o da varredura.
- **A disponibilidade depende da sessão.** `getMessageInfo` é `insiders` (pago) e `getMessageReaders` não está no bundle do open-wa; a via principal é o store do WhatsApp Web. Rode `npm run probe-reads` para o veredito na sua sessão. Se nenhuma via funcionar, o coletor se desliga sozinho e o resto do monitor segue igual.
- **Ler não é falar.** A leitura entra em `messagesRead` e mexe em `lastSeenAt`, nunca em `lastMessageAt` — quem só lê não pode aparecer como quem conversa. Pelo mesmo motivo, `messagesRead` **não** entra no `engagementScore`: o denominador seria enganoso, já que só as mensagens próprias emitidas dentro da janela têm esse dado.

---

## MongoDB: métricas de engajamento

O JSONL responde "o que aconteceu". Para responder **"quem são os apoiadores
mais engajados"** — que é a pergunta que motiva o projeto — os eventos também
vão para um MongoDB, que mantém duas coleções de leitura.

Basta preencher `MONGODB_URI` no `.env`. Sem ela, o monitor roda exatamente
como antes, gravando só o arquivo.

```bash
npm run mongo:import   # carrega o JSONL que já existe (pode rodar quantas vezes quiser)
npm run mongo:build    # recalcula as métricas derivadas
npm run mongo:size     # quanto do plano gratuito já foi usado
```

O JSONL **continua sendo o log durável**. Se o Mongo cair, o monitor segue
gravando em disco e `mongo:import` recupera o intervalo depois.

### As coleções

Todas nascem com o sufixo `MONGO_COLLECTION_SUFFIX` (`_teste` por padrão).
Enquanto ele tiver valor, nada encosta em coleções de produção; para valer,
esvazie a variável.

| Coleção | Um documento é | Para quê |
|---|---|---|
| **`people`** | uma pessoa | **a coleção principal** — quem engaja, quanto e como |
| **`groups`** | um grupo | saúde e composição do grupo |
| `activity_daily` | grupo × pessoa × dia | a série temporal |
| `messages` | uma mensagem | fonte dos recálculos |
| `reactions` | uma reação | estado atual (`active`), não histórico |
| `member_events` | uma entrada/saída/promoção | histórico de composição |
| `message_reads` | uma pessoa que abriu uma mensagem **sua** | quem lê sem responder |
| `poll_votes` | um voto em enquete | ver a seção de enquetes |
| `events` | um evento cru | cópia do JSONL; opcional |

**Reimportar não duplica nem infla contador.** Todo `_id` é derivado do
conteúdo (o `eventId` é um UUID novo a cada emissão e não serviria), e no
caminho quente um contador só é incrementado quando o documento acabou de ser
criado. Rodar `mongo:import` cinco vezes dá o mesmo resultado que rodar uma.

### Como uma pessoa é identificada

Este é o ponto que mais afeta a qualidade dos números. O WhatsApp entrega a
mesma pessoa por dois caminhos:

| origem | id |
|---|---|
| mensagens e reações | `146926720831515@lid` |
| lista de participantes | `5511988812345@c.us` |

Sem unificar, cada apoiador vira dois documentos e as métricas saem pela
metade. Por isso o `_id` de `people` é o **telefone** (`5511988812345`), e todos
os ids do WhatsApp ficam em `aliases[]`. Quando o telefone ainda não é
conhecido, a pessoa recebe um `_id` provisório `lid:<id>`, e o recálculo funde
os dois assim que o vínculo aparece.

Números brasileiros ganham `ddd`; qualquer outro país é apenas marcado com
`isInternational` — códigos de país têm de 1 a 3 dígitos e não dá para separá-los
com segurança sem uma tabela de prefixos, então não se tenta.

### O que tem em `people`

Prioridade nas métricas cruas; os scores existem só para dar uma ordenação
padrão.

- **Volume** — `messagesSent`, `mediaSent`, `charsSent`, `linksShared`
- **Conversa** — `repliesSent`, `repliesReceived`, `mentionsMade`,
  `mentionsReceived`
- **Reações** — `reactionsGiven`, `reactionsReceived`, `emojisUsed`,
  `distinctPeopleWhoReacted`, `distinctPeopleReactedTo` (alcance na rede, que é
  diferente de volume)
- **Leitura** — `messagesRead`: quantas mensagens **suas** a pessoa abriu (ver a
  seção sobre confirmação de leitura). Fora do `engagementScore` de propósito
- **Ritmo** — `activeDays`, `activeDaysLast30`, `currentStreakDays`,
  `longestStreakDays`, `daysSinceLastMessage`, `hourHistogram`,
  `weekdayHistogram`
- **Taxas** — `reactionsReceivedPerMessage` (ressonância),
  `repliesReceivedPerMessage`, `messagesPerActiveDay`
- **Tendência** — `messagesLast7d`, `messagesPrev7d`, `trend7d`
- **Participação** — `groups[]` com contadores por grupo, `groupCount`,
  `activeGroupCount`
- **Sinalizadores** — `isLurker` (é membro e nunca falou), `isDormant`,
  `isObserver` (fala pouco mas reage), `isAdminSomewhere`, `isMultiGroup`
- **Ordenação** — `engagementScore` (0–100) e `tier`

O `engagementScore` é um **percentil**, não um valor absoluto: 40 mensagens num
grupo de 20 pessoas não significam o mesmo que num de 800. Assim, 90 quer dizer
sempre "está entre os 10% mais engajados". A fórmula pondera volume (35%),
consistência (30%), ressonância (20%) e recência (15%) — os pesos e os cortes de
faixa estão todos em `src/mongo/scoring.ts`, num objeto só, para mudar sem
tocar em pipeline.

`tier` é `champion` · `active` · `occasional` · `observer` · `lurker` ·
`dormant`. Os três últimos vêm antes do score de propósito: para decidir um
convite, "nunca escreveu mas reage em tudo" e "era campeão e sumiu há dois
meses" dizem mais que a posição no ranking.

### O que tem em `groups`

Além de `participants[]`, `memberCount`, `joins`/`leaves` e os totais:

- `participationRate` e `silentMemberCount` — a diferença entre um grupo de 800
  pessoas e um grupo com 800 pessoas conversando
- `reactionRate`, `replyRate`, `avgReactionsPerMessage`
- `top10SharePct` e `giniMessages` — concentração: a conversa é de todos ou de
  meia dúzia?
- `topPosters`, `topReactors`, `topReceivers`
- `peakHours` — quando vale a pena mandar um convite
- `dddDistribution` — orienta convite para evento regional
- `trend7d`, `daysSinceLastMessage`

### Consultas típicas

```js
// Os 50 apoiadores mais engajados, com o que sustenta o número
db.people_teste.find({ tier: { $in: ['champion', 'active'] } })
  .sort({ engagementScore: -1 }).limit(50)
  .project({ name: 1, phone: 1, ddd: 1, engagementScore: 1, tier: 1,
             messagesSent: 1, reactionsReceived: 1, activeDaysLast30: 1 })

// Quem está esquentando agora — costuma valer mais que quem já foi ativo
db.people_teste.find({ trend7d: 'rising', messagesLast7d: { $gte: 5 } })
  .sort({ messagesLast7d: -1 })

// Membros silenciosos de um grupo: invisíveis nas contagens, mas alcançáveis
db.people_teste.find({ isLurker: true, 'groups.groupId': '1203...@g.us' })

// Quem repercute sem falar muito — o "observador" que vale um convite
db.people_teste.find({ isObserver: true, reactionsGiven: { $gte: 10 } })

// Série de mensagens por dia de um grupo
db.activity_daily_teste.find({ groupId: '1203...@g.us', personId: null })
  .sort({ date: 1 })
```

### Orçamento de espaço no plano gratuito

O M0 do Atlas dá **512 MB**, contando dados **e** índices. Com o texto completo
das mensagens gravado, o custo medido em disco fica em torno de:

| | com log bruto | só coleções de domínio |
|---|---|---|
| mensagem | ~1,0 KB | ~0,55 KB |
| reação | ~0,5 KB | ~0,25 KB |
| leitura | — (fora do log bruto) | ~0,4 KB |

Na prática, o teto é **~6.000 mensagens/dia** com o log bruto ligado e
**~11.000/dia** sem ele. Abaixo de ~3.000/dia o log bruto é confortável.

Duas decisões que já economizam bastante:

- **Snapshots de grupo não são gravados.** Eram o maior sorvedouro: um grupo de
  830 membros dá ~100 KB por snapshot, e sai um a cada mudança de participante —
  ~2 MB/dia num único grupo, mais que todas as mensagens juntas. O evento
  continua sendo processado para atualizar a composição do grupo e resolver
  telefones; só não vira documento histórico. O JSONL local guarda tudo.
- **Confirmações de leitura também ficam fora do log bruto.** É o evento de
  maior cardinalidade do projeto: uma mensagem sua num grupo de 250 pessoas
  gera até 250 deles, contra 1 de mensagem e um punhado de reações. E, ao
  contrário de uma mensagem, não há conteúdo a preservar — o documento em
  `message_reads` já é tudo que existe. Contando 5 mensagens suas por dia com
  ~150 leitores cada, dá ~9 MB/mês; com log bruto seriam ~22 MB.
- O índice de `quotedMsgId` é esparso, já que a maioria das mensagens não cita
  ninguém e o id do WhatsApp tem ~80 caracteres.

Se apertar: `MONGO_RAW_LOG=false` desliga o log bruto (~45% do espaço), e
`MONGO_RAW_LOG_TTL_DAYS=90` descarta automaticamente o que passar de 90 dias.
Rode `npm run mongo:size` para ver o consumo real e a data projetada em que o
teto é atingido.

### Enquetes: votos não são capturáveis

Investigado com sessão real em 13/08/2026 (`npm run probe-polls`). **Quem votou
não dá para saber**, e a limitação é do WhatsApp, não do código.

O que o diagnóstico encontrou no store do WhatsApp Web, na mensagem da enquete:

```
__x_pollName                   "Sábado que horas"
__x_pollOptions                array(3)
__x_pollVotesSnapshot          { "pollVotes": [] }     <- vazio
Store.PollVote                 0 modelos (só getByMsgKey, sem loader)
```

A estrutura dos votos existe e está **vazia**. Votos de enquete são
criptografados ponta a ponta e decifrados pelo aparelho principal; um aparelho
conectado recebe o invólucro, não o conteúdo. Um voto emitido ao vivo, com a
sessão no ar, também não populou nada. `client.getPollData` do open-wa, além
disso, lança dentro do próprio JS do WhatsApp Web (`getAlternateMsgKey`) — a
implementação vem de um patch remoto e está quebrada, mas isso é secundário:
mesmo funcionando, não haveria voto para ler.

Consequência: **`pollVotesCast` e `pollResponseRate` ficam sempre nulos.**

O que continua legível é a **criação** da enquete — autor, data, pergunta e
opções. Como sinal de mobilização isso não é pouco: quem cria enquete costuma
ser quem organiza. É o que alimenta `pollsCreated` e `groups.totalPolls`.

Rode `npm run probe-polls` de novo se algum dia o WhatsApp mudar isso; o
diagnóstico é somente leitura e repetível.

---

## Privacidade

**Nada sai da sua máquina.** As conexões de saída em operação normal são apenas para `web.whatsapp.com`, que é inerente ao funcionamento do WhatsApp Web.

- `blockCrashLogs: true` — bloqueia as chamadas do browser para `dit.whatsapp.net/deidentified_telemetry` e `crashlogs.whatsapp.net` (telemetria da própria Meta).
- `skipUpdateCheck: true` — desliga o GET de checagem de versão que a lib faria em `raw.githubusercontent.com` no boot.
- Sem licença configurada, não há chamada a servidor de licenças. Sem `messagePreprocessor: UPLOAD_CLOUD`, não há upload de mídia para nuvem. Nenhum webhook, banco remoto ou serviço externo.

**Escopo da captura.** A sessão é um WhatsApp Web completo, então o processo *recebe* eventos de todas as suas conversas. O filtro de whitelist é aplicado na primeira linha de cada handler: o que não está em `MONITORED_GROUPS` é descartado em memória e **nunca é escrito em disco**.

**Nunca versione `data/`.** O diretório contém as credenciais de autenticação da sessão (`data/session/`) e todo o conteúdo capturado. Já está no `.gitignore`; vazar esses arquivos equivale a entregar acesso à conta.

---

## Ciclo de vida da sessão

A sessão é um *aparelho conectado* (multi-device):

- **Revoga a sessão** (exige novo QR): reinstalar o WhatsApp, resetar o celular, ou remover o aparelho em *Aparelhos conectados*.
- **Não revoga**: apenas limpar o histórico de conversas no celular.
- O WhatsApp expira aparelhos conectados após ~14 dias sem o celular ficar online. O celular precisa aparecer online periodicamente.

**Para encerrar de vez**, faça as duas coisas — uma não implica a outra:

1. No celular: *Aparelhos conectados* → remover o aparelho.
2. Na máquina: `rm -rf data/session/`.

---

## Configuração

Tudo em `.env` (veja `.env.example`):

| Variável | Default | O que faz |
|---|---|---|
| `SESSION_ID` | `wa-monitor` | Nome do arquivo de credenciais em `data/session/` |
| `HEADLESS` | `true` | Sem janela do Chromium; o QR sai no terminal. `false` abre a janela, útil só para depurar |
| `EVENTS_FILE` | `data/events.jsonl` | Onde os eventos são gravados |
| `EVENTS_MAX_BYTES` | `52428800` | Rotaciona o arquivo ao passar deste tamanho |
| `REACTION_POLL_MS` | `30000` | Intervalo do polling de reações |
| `REACTION_WINDOW_SIZE` | `2000` | Mensagens por grupo sob observação de reações |
| `REACTION_WINDOW_HOURS` | `48` | Idade máxima na janela; nunca menor que `BACKFILL_DAYS` |
| `ROSTER_TTL_MS` | `900000` | TTL do cache de nomes/números |
| `BACKFILL_ENABLED` | `true` | Recupera histórico no boot |
| `BACKFILL_DAYS` | `7` | Janela do primeiro contato com um grupo |
| `BACKFILL_MAX_MESSAGES` | `5000` | Teto de paginação por grupo |
| `USER_AGENT` | *(auto)* | UA enviado ao WA Web. Nunca use um com prefixo `WhatsApp/` |
| `USE_CHROME` | `false` | `true` usa o Chrome do sistema em vez do Chromium do puppeteer |
| `CHROME_PATH` | — | Caminho explícito de um navegador |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MONGODB_URI` | — | Vazio = Mongo desligado, grava só o JSONL. Contém senha: só no `.env` |
| `MONGODB_DB` | `wa_monitor` | Banco de destino |
| `MONGO_COLLECTION_SUFFIX` | `_teste` | Sufixo de todas as coleções. Esvazie para produção |
| `MONGO_RAW_LOG` | `true` | Grava também o log bruto (snapshots ficam de fora) |
| `MONGO_RAW_LOG_TTL_DAYS` | `0` | `0` = nunca expira; `90` descarta log com mais de 90 dias |
| `MONGO_FLUSH_MS` / `MONGO_FLUSH_MAX` | `2000` / `200` | Janela e tamanho do lote de escrita |
| `METRICS_REFRESH_MS` | `300000` | Recálculo dentro do monitor; `0` = só sob demanda |

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | Roda o monitor com hot reload |
| `npm run build` && `npm start` | Compila e roda a versão compilada |
| `npm run list-groups` | Lista os grupos da conta com seus ids; grava em `data/grupos.txt`. Aceita filtro: `-- parte-do-nome` |
| `npm run compact` | Converte o JSONL num array `.json` |
| `npm run mongo:import` | Carrega o JSONL no MongoDB; idempotente |
| `npm run mongo:build` | Recalcula as métricas; `-- --full` reconta tudo do zero |
| `npm run mongo:size` | Uso do cluster vs. os 512 MB do plano gratuito |
| `npm run probe-polls` | Verifica se enquetes são capturáveis nesta sessão |
| `npm run probe-reads` | Verifica se dá para saber quem leu suas mensagens |
| `npm test` | Suíte de testes (não precisa de sessão nem de rede) |
| `npm run typecheck` | Checagem de tipos |

## Estrutura

```
src/
├─ index.ts              entrypoint: sessão, coletores, shutdown
├─ config.ts             .env validado com zod (inclui a whitelist)
├─ session.ts            wrapper do create() do open-wa
├─ types.ts              contrato dos eventos
├─ sink/                 destinos: JSONL (durável), Mongo, e o fan-out
├─ collectors/           messages, participants, reactions, readReceipts, backfill
├─ mongo/                ingestão, recálculo, identidade e pesos do score
├─ enrich/               roster (nome/número), ponte LID→@c.us, dados da mensagem
└─ util/                 logger, conversões de id/timestamp e buckets de tempo
```

Coletores e sink são desacoplados por interface: o `MultiSink` escreve no
arquivo e no banco ao mesmo tempo, e a falha de um destino não impede o outro.

Coletores e sink são desacoplados por interface: trocar o destino (Postgres, S3) ou a fonte não obriga a mexer no resto.

---

## Notas técnicas

- **Por que sobrescrevemos o user-agent.** O `@open-wa/wa-automate` 4.76.0 envia por padrão o UA `WhatsApp/2.2147.16 … Chrome/104.0.0.0`, e o WhatsApp Web hoje **rejeita qualquer UA com o prefixo `WhatsApp/`**, devolvendo a página *"WhatsApp works with Google Chrome 100+"*. A mensagem é enganosa: a versão do navegador não tem nada a ver — com o prefixo, Chrome 104 e Chrome 131 falham igual; sem o prefixo, ambos carregam.

  A opção `customUserAgent` do config **não resolve**, porque a lib só a lê quando `inDocker: true` (em `controllers/initializer.js`, a variável é atribuída dentro desse `if` e chega `undefined` em `initPage`). Por isso `src/session.ts` sobrescreve o UA padrão do módulo antes do `create()`. Se um dia o WA Web recusar de novo, é só definir `USER_AGENT` no `.env`.

- **Não é preciso ter Chrome instalado.** O Chromium que o puppeteer baixa junto funciona. `USE_CHROME` e `CHROME_PATH` existem só como escape hatch.


- **Por que v4.76.0 e não v5?** A v5 (alpha) declara `onReaction` e `onParticipantsChanged` como gratuitos no schema, mas o runtime só faz binding real de 6 eventos — reações e mudança de participantes não são emitidas. A v4 entrega os eventos de participantes de graça e permite derivar as reações.
- **Risco de ban.** A doc do open-wa aponta o envio não solicitado como o principal fator de risco. Este projeto só lê, o que mantém o risco baixo. Ainda assim: é software não oficial, não afiliado ao WhatsApp/Meta, e o uso é por sua conta e risco.

## Licença

Uso privado. O `@open-wa/wa-automate` é distribuído sob a Hippocratic + Do No Harm License — vale conferir os termos se este projeto sair do uso pessoal.
