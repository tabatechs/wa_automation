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

import { preparePage, SERIALIZER_SHIM } from '../src/util/page';

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

  // --- reinstala sempre, de propósito ---
  {
    // Havia aqui um cache de páginas já preparadas, e ele mentia. O objeto
    // `Page` do puppeteer SOBREVIVE a uma navegação — o que troca é o `window`
    // dentro dele. Depois de navegar, o cache respondia "já preparei" enquanto
    // o `__name` tinha ido embora com o documento antigo, e todo `evaluate` com
    // função voltava a morrer em `ReferenceError`, engolido pelo try/catch de
    // quem chama. Era o bug que manteve a ponte LID→telefone quebrada por meses,
    // ressuscitado a cada reconexão.
    const { page, calls } = fakePage();
    await preparePage(page);
    await preparePage(page);
    await preparePage(page);
    assert.strictEqual(
      calls.length,
      3,
      'o shim tem de ser reinstalado a cada chamada: navegação zera o window ' +
        'sem trocar o objeto Page',
    );
    ok('preparar a mesma página de novo REINSTALA o shim (navegação zera o window)');
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

  // --- remendo do serializador (quotedMsgObj) --------------------------------

/**
 * Reproduz o serializador da 4.76.0 e o model quebrado do WA Web atual, para
 * exercitar o remendo sem browser: `quotedMsgObj` é propriedade, não método, e
 * o serializador a chama descartando o retorno.
 */
function fakeWapi() {
  const chamadas: string[] = [];
  const original = (obj: any) => {
    if (!obj) return null;
    chamadas.push(obj.id);
    // A linha exata do wapi.js:131 — chamada com retorno descartado.
    if (obj.quotedMsg) obj.quotedMsgObj();
    return { id: obj.id, quotedMsgId: obj.quotedMsg?.id ?? null };
  };
  return { _serializeMessageObj: original, chamadas };
}

function aplicarShim(wapi: unknown): string {
  const janela = { WAPI: wapi } as Record<string, unknown>;
  // O shim referencia `window`; em Node damos um à mão.
  const fn = new Function('window', `return ${SERIALIZER_SHIM};`);
  return fn(janela) as string;
}

/** Mensagem que cita outra, com `quotedMsgObj` como propriedade (o caso novo). */
function mensagemCitando(id: string) {
  return {
    id,
    quotedMsg: { id: 'ABC123' },
    quotedMsgObj: { id: 'ABC123', body: 'a citada' }, // propriedade, não função
  };
}

{
  // Sem o remendo, o serializador estoura exatamente como em produção.
  const wapi = fakeWapi();
  assert.throws(
    () => wapi._serializeMessageObj(mensagemCitando('m1')),
    /is not a function/,
    'o cenário de produção é reproduzido',
  );
  ok('sem remendo, mensagem citada quebra o serializador');
}

{
  const wapi = fakeWapi();
  assert.strictEqual(aplicarShim(wapi), 'aplicado');

  const msg = mensagemCitando('m1');
  const saida = wapi._serializeMessageObj(msg) as { quotedMsgId: string | null };
  assert.strictEqual(saida.quotedMsgId, 'ABC123', 'quotedMsgId sobrevive — é o que usamos');
  ok('com o remendo, mensagem citada serializa e mantém quotedMsgId');

  // O model tem de voltar exatamente como estava: se o WA Web ler
  // `quotedMsgObj` esperando o objeto, uma função no lugar quebraria a página.
  assert.deepStrictEqual(
    msg.quotedMsgObj,
    { id: 'ABC123', body: 'a citada' },
    'o descritor original é restaurado depois da serialização',
  );
  ok('o remendo não deixa resíduo no model do WhatsApp');
}

{
  // Um lote com uma única resposta no meio: é o que derruba getAllMessagesInChat.
  const wapi = fakeWapi();
  aplicarShim(wapi);
  const lote = [{ id: 'a', quotedMsg: null }, mensagemCitando('b'), { id: 'c', quotedMsg: null }];
  const saida = lote.map((m) => wapi._serializeMessageObj(m));
  assert.strictEqual(saida.length, 3);
  assert.strictEqual(wapi.chamadas.length, 3, 'nenhuma mensagem é chamada duas vezes');
  ok('lote inteiro sobrevive a uma resposta no meio');
}

{
  const wapi = fakeWapi();
  assert.strictEqual(aplicarShim(wapi), 'aplicado');
  assert.strictEqual(aplicarShim(wapi), 'ja-aplicado', 'não embrulha duas vezes');
  ok('remendo é idempotente');
}

{
  // Se um dia a biblioteca ou o WhatsApp consertarem, o remendo sai do caminho.
  const wapi = fakeWapi();
  aplicarShim(wapi);
  const msg = { id: 'm1', quotedMsg: { id: 'X' }, quotedMsgObj: () => ({ id: 'X' }) };
  assert.doesNotThrow(() => wapi._serializeMessageObj(msg));
  assert.strictEqual(typeof msg.quotedMsgObj, 'function', 'método intacto');
  ok('quando quotedMsgObj volta a ser método, o remendo não interfere');
}

{
  assert.strictEqual(aplicarShim({}), 'sem-wapi', 'sem serializador, desiste em silêncio');
  ok('WAPI ausente não vira exceção');
}

console.log('\npage\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
