/*
 * O shim de __name.
 *
 * Sem ele, todo page.evaluate com função aninhada morre no browser com
 * "ReferenceError: __name is not defined" — o esbuild (via tsx) embrulha as
 * funções nomeadas num helper que só existe no processo Node, e o puppeteer
 * manda o código-fonte da função para a página. Foi o que manteve a consulta
 * ao store do LidResolver quebrada em silêncio.
 */
import assert from 'node:assert';

import { preparePage } from '../src/util/page';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

function fakePage(onEvaluate?: (arg: unknown) => void) {
  const calls: unknown[] = [];
  return {
    page: {
      evaluate: async (arg: unknown) => {
        calls.push(arg);
        onEvaluate?.(arg);
      },
    },
    calls,
  };
}

async function run() {
  // --- instala o shim ---
  {
    const { page, calls } = fakePage();
    assert.strictEqual(await preparePage(page), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      typeof calls[0], 'string',
      'o shim vai como STRING: uma função passaria pelo esbuild e dependeria do ' +
        'próprio __name que estamos criando',
    );
    assert.ok(String(calls[0]).includes('__name'));
    ok('instala o shim de __name passando código como string');
  }

  // --- idempotente ---
  {
    const { page, calls } = fakePage();
    await preparePage(page);
    await preparePage(page);
    await preparePage(page);
    assert.strictEqual(calls.length, 1, 'a mesma página não é preparada de novo');
    ok('preparar a mesma página várias vezes custa um evaluate só');
  }

  // --- páginas diferentes são preparadas cada uma ---
  {
    const a = fakePage();
    const b = fakePage();
    await preparePage(a.page);
    await preparePage(b.page);
    assert.strictEqual(a.calls.length, 1);
    assert.strictEqual(b.calls.length, 1, 'sessão reiniciada traz página nova');
    ok('cada página é preparada por conta própria');
  }

  // --- falha não lança: o chamador decide o que fazer ---
  {
    const page = { evaluate: async () => { throw new Error('página morta'); } };
    assert.strictEqual(
      await preparePage(page), false,
      'devolve false em vez de lançar — perder o enriquecimento é aceitável, ' +
        'derrubar o monitor não',
    );
    ok('página morta devolve false em vez de lançar');
  }

  // --- entradas degeneradas ---
  {
    assert.strictEqual(await preparePage(null), false);
    assert.strictEqual(await preparePage(undefined), false);
    ok('sem página, devolve false');
  }

  console.log('\npage\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
