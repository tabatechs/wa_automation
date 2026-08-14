/* parsePhone: DDD só para número brasileiro, resto é só "internacional". */
import assert from 'node:assert';

import { parsePhone, e164ToDigits } from '../src/util/phone';

const results: string[] = [];
function ok(name: string) { results.push(`  ✓ ${name}`); }

// --- e164ToDigits ---
assert.strictEqual(e164ToDigits('+5511988812345'), '5511988812345');
assert.strictEqual(e164ToDigits('5511988812345'), '5511988812345');
assert.strictEqual(e164ToDigits('+55 (11) 98881-2345'), '5511988812345');
assert.strictEqual(e164ToDigits(null), null);
assert.strictEqual(e164ToDigits('+12'), null, 'curto demais para ser telefone');
ok('e164ToDigits normaliza para dígitos e rejeita lixo');

// --- celular brasileiro ---
assert.deepStrictEqual(parsePhone('+5511988812345'), {
  isInternational: false,
  ddd: '11',
  isMobile: true,
});
ok('celular de SP: DDD 11, isMobile true');

// --- fixo brasileiro de 8 dígitos ---
assert.deepStrictEqual(parsePhone('+551133334444'), {
  isInternational: false,
  ddd: '11',
  isMobile: false,
});
ok('fixo de 8 dígitos: DDD 11, isMobile false');

// --- DDD de dois dígitos que não é 11 ---
assert.strictEqual(parsePhone('+5521994312345').ddd, '21');
assert.strictEqual(parsePhone('+5568817212345').ddd, '68');
ok('DDD lido corretamente fora de SP');

// --- internacional: NÃO tenta adivinhar o código de país ---
const usa = parsePhone('+14155552671');
assert.strictEqual(usa.isInternational, true);
assert.strictEqual(usa.ddd, null, 'internacional não tem DDD');
assert.strictEqual(usa.isMobile, null, 'internacional não tem como saber se é celular');
ok('número dos EUA vira só isInternational, sem DDD inventado');

// Portugal (+351) e Reino Unido (+44): códigos de 3 e 2 dígitos, mesmo tratamento.
for (const foreign of ['+351912345678', '+447911123456', '+8613800138000']) {
  const parsed = parsePhone(foreign);
  assert.strictEqual(parsed.isInternational, true, `${foreign} deveria ser internacional`);
  assert.strictEqual(parsed.ddd, null);
}
ok('códigos de país de 1, 2 e 3 dígitos caem todos no mesmo caminho');

// --- casos degenerados ---
assert.deepStrictEqual(parsePhone(null), { isInternational: false, ddd: null, isMobile: null });
assert.deepStrictEqual(parsePhone(''), { isInternational: false, ddd: null, isMobile: null });
ok('sem número, nenhum campo é preenchido');

// Começa com 55 mas não tem forma de número brasileiro: não inventa DDD.
assert.strictEqual(parsePhone('+555123456').ddd, null);
ok('prefixo 55 com formato inválido não vira DDD');

console.log('\nphone\n' + results.join('\n') + `\n\n${results.length} verificações OK\n`);
