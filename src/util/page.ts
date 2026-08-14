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
