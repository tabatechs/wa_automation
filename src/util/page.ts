/**
 * Prepara a página do puppeteer para receber `page.evaluate`.
 *
 * ## O problema
 *
 * O projeto roda por `tsx`, que compila com esbuild. O esbuild preserva o nome
 * de funções embrulhando-as num helper próprio:
 *
 *     const f = __name((x) => x, "f");
 *
 * O `page.evaluate` não envia o *closure* — ele serializa o **código-fonte** da
 * função e o avalia dentro do browser. Lá, `__name` não existe, e qualquer
 * `evaluate` com função aninhada morre com:
 *
 *     ReferenceError: __name is not defined
 *
 * O sintoma é traiçoeiro porque o código parece correto e o erro só aparece em
 * runtime, dentro do browser. No `LidResolver` isso derrubava silenciosamente
 * a consulta ao store — o fallback da ponte LID→telefone nunca funcionou, e a
 * falha era absorvida pelo `try/catch` que existe para não perder eventos.
 *
 * ## A correção
 *
 * Definir um `__name` inócuo na página antes do primeiro `evaluate`. O shim é
 * instalado passando uma **string** para `evaluate` — string não passa pelo
 * esbuild e, portanto, não depende do helper que estamos justamente criando.
 */

import { createLogger } from './logger';

const log = createLogger('page');

/** Páginas já preparadas, para não reinstalar o shim a cada chamada. */
const prontas = new WeakSet<object>();

interface PageLike {
  evaluate(fn: string): Promise<unknown>;
}

/**
 * Instala o shim de `__name`. Idempotente e seguro de chamar sempre.
 * Devolve false se a página não aceitou — aí `evaluate` com função vai falhar
 * e o chamador deve ter um caminho alternativo.
 */
export async function preparePage(page: unknown): Promise<boolean> {
  if (!page || typeof page !== 'object') return false;
  if (prontas.has(page)) return true;

  try {
    await (page as PageLike).evaluate(
      'globalThis.__name = globalThis.__name || function (fn) { return fn; };',
    );
    prontas.add(page);
    return true;
  } catch (error) {
    log.debug('não foi possível preparar a página', { error: String(error) });
    return false;
  }
}

/**
 * Remendo para `WAPI._serializeMessageObj`, quebrado pelo WhatsApp Web atual.
 *
 * ## O problema
 *
 * Em `node_modules/@open-wa/wa-automate/dist/lib/wapi.js:131` o serializador faz:
 *
 *     if (obj.quotedMsg) obj.quotedMsgObj();
 *
 * `quotedMsgObj` deixou de ser método no model de mensagem do WA Web — virou
 * propriedade —, e a chamada estoura `TypeError: obj.quotedMsgObj is not a
 * function`. A biblioteca depende de engenharia reversa e quebra a cada
 * mudança da Meta; a 4.76.0 é a última publicada (08/07/2026) e não corrige,
 * e a linha 5.0.0-alpha é um esqueleto sem WAPI. Não há atualização a fazer.
 *
 * ## Por que derruba o monitor inteiro
 *
 * A chamada só acontece quando a mensagem **cita outra** — mas ela não está
 * protegida, e `getAllMessagesInChat` serializa o lote inteiro de uma vez.
 * Basta **uma** resposta na janela para a varredura toda morrer. Como todo
 * grupo vivo tem respostas, na prática o backfill e o coletor de reações param
 * de devolver qualquer coisa, e `onAnyMessage` perde as mensagens citadas.
 *
 * ## O contorno
 *
 * O retorno de `obj.quotedMsgObj()` é **descartado** pelo próprio serializador:
 * a chamada existia só pelo efeito colateral de popular `_quotedMsgObj`. E nada
 * neste projeto lê o objeto da mensagem citada — `quotedMsgId` sai de
 * `message.quotedMsg.id`, que é propriedade crua e continua intacta. Então
 * basta tornar a chamada inofensiva.
 *
 * O remendo instala a função só durante a serialização e **restaura o
 * descritor original no `finally`**. Mexer de forma permanente no model seria
 * arriscado: se o próprio WA Web ler `msg.quotedMsgObj` esperando o objeto,
 * uma função no lugar quebraria a interface.
 */
export const SERIALIZER_SHIM = `(function () {
  var W = window.WAPI;
  if (!W || typeof W._serializeMessageObj !== 'function') return 'sem-wapi';
  if (W.__quotedMsgObjPatched) return 'ja-aplicado';

  var original = W._serializeMessageObj;
  var inocua = function () { return undefined; };

  W._serializeMessageObj = function (obj) {
    if (!obj || typeof obj !== 'object') return original.call(this, obj);

    var atual;
    try { atual = obj.quotedMsgObj; } catch (e) { atual = undefined; }
    if (typeof atual === 'function') return original.call(this, obj);

    var descritor = Object.getOwnPropertyDescriptor(obj, 'quotedMsgObj');
    var instalado = false;
    try {
      Object.defineProperty(obj, 'quotedMsgObj', {
        value: inocua, configurable: true, writable: true, enumerable: false
      });
      instalado = true;
    } catch (e) { /* objeto selado: falha como falhava, sem piorar */ }

    try {
      return original.call(this, obj);
    } finally {
      if (instalado) {
        if (descritor) Object.defineProperty(obj, 'quotedMsgObj', descritor);
        else { try { delete obj.quotedMsgObj; } catch (e) {} }
      }
    }
  };

  W.__quotedMsgObjPatched = true;
  return 'aplicado';
})()`;

/**
 * Aplica o remendo acima. Idempotente: o próprio código injetado desiste se já
 * estiver aplicado, e reinstala sozinho se o WAPI for reinjetado (reconexão).
 *
 * Nunca lança: sem o remendo o monitor perde mensagem citada, mas com uma
 * exceção aqui ele não sobe.
 */
export async function patchMessageSerializer(page: unknown): Promise<string | null> {
  if (!page || typeof page !== 'object') return null;
  try {
    const resultado = await (page as PageLike).evaluate(SERIALIZER_SHIM);
    const estado = typeof resultado === 'string' ? resultado : 'desconhecido';
    if (estado === 'aplicado') log.info('remendo do serializador aplicado (quotedMsgObj)');
    else if (estado === 'sem-wapi') log.warn('WAPI ausente; remendo do serializador não aplicado');
    return estado;
  } catch (error) {
    log.error('falha ao aplicar o remendo do serializador', error);
    return null;
  }
}
