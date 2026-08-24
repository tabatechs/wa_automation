/*
 * Vigia da sessão.
 *
 * O que está sendo protegido: em 24/08/2026 a página do WhatsApp navegou, o
 * open-wa reinjetou o WAPI e não religou os listeners. O processo seguiu vivo,
 * com o Mongo respondendo e o recálculo de métricas no horário, capturando
 * exatamente nada por três horas — sem uma linha de erro. O vigia existe para
 * que esse estado seja detectável.
 *
 * Sem browser: a sonda é falsa e o teste dirige o estado da "página".
 */
import assert from 'node:assert';

import { SessionWatchdog, type EstadoPagina, type SessionProbe } from '../src/util/watchdog';

const out: string[] = [];
const ok = (s: string) => out.push(`  ✓ ${s}`);

class FakeProbe implements SessionProbe {
  estado: EstadoPagina = 'ok';
  religamentos = 0;
  carimbos = 0;
  /** Quando true, `carimbar` falha — página que não aceita mais nada. */
  carimboFalha = false;
  /** Quando true, `religar` lança. */
  religarFalha = false;

  async carimbar(): Promise<string | null> {
    this.carimbos += 1;
    if (this.carimboFalha) return null;
    // Um religamento bem-sucedido devolve a página ao estado bom.
    this.estado = 'ok';
    return `selo-${this.carimbos}`;
  }

  async conferir(): Promise<EstadoPagina> {
    return this.estado;
  }

  async religar(): Promise<void> {
    this.religamentos += 1;
    if (this.religarFalha) throw new Error('religamento falhou');
  }
}

function montar(probe: SessionProbe, maxFalhas = 3) {
  const desistiu: string[] = [];
  const w = new SessionWatchdog(probe, {
    intervalMs: 60_000,
    maxFalhas,
    aoDesistir: (motivo) => desistiu.push(motivo),
  });
  return { w, desistiu };
}

async function run() {
  // ---------- página intacta ----------
  {
    const probe = new FakeProbe();
    const { w, desistiu } = montar(probe);
    await w.armar();

    assert.strictEqual(await w.tick(), 'ok');
    assert.strictEqual(await w.tick(), 'ok');
    assert.strictEqual(probe.religamentos, 0, 'não pode religar sem necessidade');
    assert.deepStrictEqual(desistiu, []);
    ok('página intacta: nenhum religamento, nenhuma desistência');
  }

  // ---------- navegou: religa e recarimba ----------
  {
    const probe = new FakeProbe();
    const { w, desistiu } = montar(probe);
    await w.armar();

    probe.estado = 'navegou';
    assert.strictEqual(await w.tick(), 'religado');
    assert.strictEqual(probe.religamentos, 1);
    // O selo novo tem de valer: a rodada seguinte volta a ser rotina.
    assert.strictEqual(await w.tick(), 'ok');
    assert.deepStrictEqual(desistiu, []);
    ok('selo ausente dispara o religamento e a página é recarimbada');
  }

  // ---------- reinjeção em curso: NÃO pode religar ----------
  {
    const probe = new FakeProbe();
    const { w } = montar(probe);
    await w.armar();

    probe.estado = 'sem-wapi';
    assert.strictEqual(await w.tick(), 'esperando');
    assert.strictEqual(await w.tick(), 'esperando');
    assert.strictEqual(
      probe.religamentos,
      0,
      'religar sem WAPI estoura dentro da página: registerListener chama WAPI[nome]()',
    );
    ok('com o WAPI ainda ausente o vigia espera em vez de religar');

    // E quando o WAPI volta, aí sim religa.
    probe.estado = 'navegou';
    assert.strictEqual(await w.tick(), 'religado');
    assert.strictEqual(probe.religamentos, 1);
    ok('assim que o WAPI reaparece, o religamento acontece');
  }

  // ---------- página morta: desiste depois de maxFalhas ----------
  {
    const probe = new FakeProbe();
    const { w, desistiu } = montar(probe, 3);
    await w.armar();

    probe.estado = 'morta';
    assert.strictEqual(await w.tick(), 'falhou');
    assert.strictEqual(await w.tick(), 'falhou');
    assert.deepStrictEqual(desistiu, [], 'ainda dentro da tolerância');
    assert.strictEqual(await w.tick(), 'falhou');
    assert.strictEqual(desistiu.length, 1, 'na terceira, desiste');
    ok('página morta derruba o processo só depois de maxFalhas rodadas');
  }

  // ---------- uma recuperação zera o contador ----------
  {
    const probe = new FakeProbe();
    const { w, desistiu } = montar(probe, 3);
    await w.armar();

    probe.estado = 'morta';
    await w.tick();
    await w.tick();
    // Voltou ao normal antes de estourar a conta.
    probe.estado = 'ok';
    assert.strictEqual(await w.tick(), 'ok');
    probe.estado = 'morta';
    await w.tick();
    await w.tick();
    assert.deepStrictEqual(desistiu, [], 'falhas intercaladas não somam');
    ok('uma rodada boa zera o contador de falhas');
  }

  // ---------- religamento que lança não derruba o vigia ----------
  {
    const probe = new FakeProbe();
    const { w, desistiu } = montar(probe, 2);
    await w.armar();

    probe.estado = 'navegou';
    probe.religarFalha = true;
    assert.strictEqual(await w.tick(), 'falhou', 'exceção vira falha, não crash');
    assert.strictEqual(await w.tick(), 'falhou');
    assert.strictEqual(desistiu.length, 1);
    ok('exceção no religamento é contabilizada, não propagada');
  }

  // ---------- sem conseguir carimbar, o vigia insiste ----------
  {
    const probe = new FakeProbe();
    probe.carimboFalha = true;
    const { w } = montar(probe);

    assert.strictEqual(await w.armar(), false, 'armar avisa que não carimbou');
    assert.strictEqual(await w.tick(), 'sem-selo');
    probe.carimboFalha = false;
    assert.strictEqual(await w.tick(), 'religado', 'assim que dá, carimba');
    assert.strictEqual(await w.tick(), 'ok');
    ok('página que ainda não subiu não trava o vigia');
  }

  console.log(
    '\nSmoke test — vigia da sessão\n' + out.join('\n') + `\n\n${out.length} verificações OK\n`,
  );
}

run().catch((e) => {
  console.error('\n❌ FALHOU:', e.message);
  process.exit(1);
});
