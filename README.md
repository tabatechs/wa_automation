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

Um QR code é desenhado **no terminal** (o processo roda headless, sem janela do Chromium). No celular: **Configurações → Aparelhos conectados → Conectar um aparelho**. Depois de parear, o script imprime todos os seus grupos com os respectivos ids.

> Se preferir ver o navegador — para depurar o que a página está fazendo — rode com `HEADLESS=false`. Aí o QR aparece tanto na janela do Chromium quanto no terminal.

**2. Configure a whitelist**

Edite `config/groups.json` com o id que você quer monitorar:

```json
{
  "groups": [
    { "id": "120363000000000000@g.us", "label": "Meu grupo", "enabled": true }
  ]
}
```

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
  "capturedAt": "2026-08-11T14:03:22.114Z",
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

## Privacidade

**Nada sai da sua máquina.** As conexões de saída em operação normal são apenas para `web.whatsapp.com`, que é inerente ao funcionamento do WhatsApp Web.

- `blockCrashLogs: true` — bloqueia as chamadas do browser para `dit.whatsapp.net/deidentified_telemetry` e `crashlogs.whatsapp.net` (telemetria da própria Meta).
- `skipUpdateCheck: true` — desliga o GET de checagem de versão que a lib faria em `raw.githubusercontent.com` no boot.
- Sem licença configurada, não há chamada a servidor de licenças. Sem `messagePreprocessor: UPLOAD_CLOUD`, não há upload de mídia para nuvem. Nenhum webhook, banco remoto ou serviço externo.

**Escopo da captura.** A sessão é um WhatsApp Web completo, então o processo *recebe* eventos de todas as suas conversas. O filtro de whitelist é aplicado na primeira linha de cada handler: o que não está em `config/groups.json` é descartado em memória e **nunca é escrito em disco**.

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

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | Roda o monitor com hot reload |
| `npm run build` && `npm start` | Compila e roda a versão compilada |
| `npm run list-groups` | Lista os grupos da conta com seus ids |
| `npm run compact` | Converte o JSONL num array `.json` |
| `npm test` | Suíte de testes (não precisa de sessão nem de rede) |
| `npm run typecheck` | Checagem de tipos |

## Estrutura

```
src/
├─ index.ts              entrypoint: sessão, coletores, shutdown
├─ config.ts             .env + config/groups.json validados com zod
├─ session.ts            wrapper do create() do open-wa
├─ types.ts              contrato dos eventos
├─ sink/                 destino dos eventos (JSONL hoje, plugável)
├─ collectors/           messages, participants, reactions
├─ enrich/roster.ts      resolve nome/número com cache por TTL
└─ util/                 logger e conversões de id/timestamp
```

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
