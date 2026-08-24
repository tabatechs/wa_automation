/**
 * Quais "mensagens" do WhatsApp contam como fala.
 *
 * O `onAnyMessage` entrega tudo o que o WA Web materializa como objeto de
 * mensagem no chat — e boa parte disso ninguém escreveu. O caso maior é o
 * `gp2` ("group v2 notification"): é o aviso de sistema que aparece no balão
 * cinza centralizado — *"Fulano adicionou Beltrano"*, *"Fulano saiu"*, *"Fulano
 * mudou a descrição"*. O que distingue um `gp2` de outro é o `subtype`, e é
 * exatamente daí que sai o nosso `participants_changed`: o
 * `onGlobalParicipantsChanged` do open-wa filtra `previewMessage.type === 'gp2'`
 * e traduz `subtype` (`invite`, `add`, `remove`, `leave`, `promote`, `demote`)
 * em `action` (`dist/lib/wapi.js:1322`). Ou seja: o `gp2` é a *mesma* entrada e
 * saída que já registramos como `member_events`, vista pelo outro lado.
 *
 * ## Por que isso importa
 *
 * Não havia filtro nenhum, nem no caminho quente (`countMessage`) nem no
 * recálculo (`metrics.ts` faz `$sum: 1` sobre `messages` inteiro). Cada entrada
 * de participante virava `messagesSent += 1` para alguém. Em 24/08/2026, em
 * produção: 61 dos 500 documentos de `messages` eram `gp2` (12%), e **37 das
 * 119 pessoas com "mensagem" nunca tinham escrito uma linha** — estavam
 * classificadas como `occasional` (31) ou `observer` (6) quando são `lurker`.
 * Do outro lado, inflava os admins: quem adiciona gente ganhava uma mensagem
 * por convite.
 *
 * Isso ataca o objetivo do projeto de frente — separar quem participa de quem
 * só está no grupo é a única coisa que ele existe para fazer.
 *
 * ## O critério
 *
 * A prova de que não é fala está no próprio dado: **nenhum** dos 61 `gp2` tinha
 * `body` ou `caption`. Não é acaso — o texto que aparece na tela é montado pelo
 * cliente a partir do `subtype` e dos participantes, nunca trafega como corpo.
 * Vale para toda a família de notificação abaixo.
 *
 * `ciphertext` e `revoked` entram pelo mesmo corte, por decisão de definição e
 * não por natureza: a mensagem existiu, mas não temos o conteúdo dela. A
 * primeira não foi decifrada, a segunda foi apagada por quem escreveu. Contar
 * qualquer uma como fala credita uma participação que não é possível ler.
 *
 * O que **não** entra: `groups_v4_invite` (é um cartão que alguém enviou de
 * propósito), `poll_creation` (criar enquete é participar) e `unknown` — este
 * último é o nosso próprio fallback para `message.type` ausente, e pode muito
 * bem ser uma mensagem de verdade.
 */

/**
 * Tipos que não são fala. Descartados na captura e no `Ingestor` — o segundo é
 * necessário porque o JSONL histórico já tem `gp2` gravado, e sem o filtro lá
 * um `mongo:import` os traria de volta.
 */
export const NON_SPEECH_TYPES: ReadonlySet<string> = new Set([
  // Notificações de sistema: nunca têm corpo.
  'gp2',
  'group_notification',
  'notification',
  'notification_template',
  'e2e_notification',
  'broadcast_notification',
  'protocol',
  'call_log',
  'group-history',
  'message_history_notice',
  // Mensagem real cujo conteúdo não é legível para nós.
  'ciphertext',
  'revoked',
]);

/** `false` para o que o monitor não deve contar como mensagem enviada. */
export function isSpeech(messageType: string | null | undefined): boolean {
  if (typeof messageType !== 'string') return true; // sem tipo, assume fala
  return !NON_SPEECH_TYPES.has(messageType.trim().toLowerCase());
}
