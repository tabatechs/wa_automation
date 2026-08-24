/**
 * Vigia da sessão: detecta quando a página do WhatsApp trocou por baixo dos
 * listeners e os religa.
 *
 * ## A falha que isto cobre
 *
 * O open-wa registra cada listener em duas metades. A do Node é uma função
 * exposta pelo puppeteer (`page.exposeFunction('onMessage', ...)`); a do browser
 * é a ligação com o store (`WAPI.waitNewMessages(obj => window.onMessage(obj))`),
 * feita uma única vez, no registro.
 *
 * Quando a página **navega**, as duas metades têm destinos diferentes. A do Node
 * sobrevive: `exposeFunction` usa `addScriptToEvaluateOnNewDocument`, então o
 * puppeteer reinstala `window.onMessage` em todo documento novo. A do browser
 * morre com o `window` antigo. E o open-wa não a refaz: o handler de
 * `framenavigated` (`controllers/browser.js:97`) reinjeta o WAPI e nada mais —
 * quem chama `_reRegisterListeners()` é só o `Client.refresh()`, que não roda
 * nesse caminho.
 *
 * O resultado é um monitor que parece perfeitamente saudável: o processo vive,
 * o Mongo responde, o recálculo de métricas roda no horário — e nenhuma mensagem
 * é capturada, para sempre, sem uma linha de erro. Em 24/08/2026 isso custou
 * três horas de cegueira, descobertas só porque faltou uma mensagem no banco.
 *
 * ## Como detectar
 *
 * Carimbando um selo no `window`. Reinjeção de WAPI não mexe em propriedades
 * alheias, mas **navegação zera o `window` inteiro** — então a ausência do selo
 * é prova de que a página trocou, e é exatamente a mesma condição que mata os
 * listeners. Não é heurística: é o mesmo evento visto de outro ângulo.
 *
 * Reiniciar o processo pelo systemd resolveria, mas custa o boot inteiro (~1 min
 * sem captura, e o backfill não recupera intervalo). Religar na própria página é
 * quase instantâneo. O `process.exit` fica como último recurso.
 */

import { createLogger } from './logger';

const log = createLogger('watchdog');

/** Situação da página na última verificação. */
export type EstadoPagina =
  /** O selo está lá: nada navegou, os listeners continuam ligados. */
  | 'ok'
  /** O selo sumiu e o WAPI está presente: navegou, dá para religar agora. */
  | 'navegou'
  /** O selo sumiu e o WAPI ainda não voltou: reinjeção em curso, esperar. */
  | 'sem-wapi'
  /** A página não respondeu. */
  | 'morta';

/**
 * O que o vigia precisa saber fazer. É uma interface para que o teste possa
 * dirigir o vigia sem browser nenhum.
 */
export interface SessionProbe {
  /** Carimba o selo e devolve o valor instalado; null se a página não respondeu. */
  carimbar(): Promise<string | null>;
  /** Confere se o selo continua na página. */
  conferir(selo: string): Promise<EstadoPagina>;
  /** Religa os listeners do open-wa na página nova. Pode lançar. */
  religar(): Promise<void>;
}

export interface WatchdogOptions {
  intervalMs: number;
  /** Quantas rodadas seguidas sem recuperar antes de desistir. */
  maxFalhas: number;
  /** Chamado quando o vigia desiste. O padrão é derrubar o processo. */
  aoDesistir?: (motivo: string) => void;
}

export type ResultadoTick = 'ok' | 'religado' | 'esperando' | 'falhou' | 'sem-selo';

export class SessionWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private selo: string | null = null;
  private falhas = 0;
  private rodando = false;

  constructor(
    private readonly probe: SessionProbe,
    private readonly options: WatchdogOptions,
  ) {}

  /** Carimba a página pela primeira vez. Chame depois de registrar os listeners. */
  async armar(): Promise<boolean> {
    this.selo = await this.probe.carimbar();
    if (!this.selo) {
      log.warn('não foi possível carimbar a página; o vigia seguirá tentando');
      return false;
    }
    this.falhas = 0;
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    // Não segura o processo vivo sozinho.
    this.timer.unref?.();
    log.info('vigia da sessão ativo', { intervaloMs: this.options.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Uma rodada de verificação. Público para o teste; nunca lança — o vigia não
   * pode ser a causa de uma queda.
   */
  async tick(): Promise<ResultadoTick> {
    // Uma rodada lenta (página travada) não pode empilhar com a seguinte.
    if (this.rodando) return 'esperando';
    this.rodando = true;
    try {
      return await this.rodada();
    } catch (error) {
      log.error('falha inesperada no vigia', error);
      return 'falhou';
    } finally {
      this.rodando = false;
    }
  }

  private async rodada(): Promise<ResultadoTick> {
    if (!this.selo) {
      const armado = await this.armar();
      return armado ? 'religado' : 'sem-selo';
    }

    const estado = await this.probe.conferir(this.selo);

    if (estado === 'ok') {
      this.falhas = 0;
      return 'ok';
    }

    if (estado === 'sem-wapi') {
      // Reinjeção em curso. Religar agora estouraria dentro da página, porque
      // `registerListener` chama `WAPI[nome](...)` e o WAPI ainda não existe.
      log.debug('página sem WAPI; aguardando a reinjeção terminar');
      return 'esperando';
    }

    if (estado === 'morta') {
      this.falhas += 1;
      log.warn('a página não respondeu', { falhas: this.falhas });
      this.talvezDesistir('a página do WhatsApp parou de responder');
      return 'falhou';
    }

    // estado === 'navegou'
    log.warn(
      'a página do WhatsApp navegou — os listeners do open-wa não sobrevivem a isso; religando',
    );
    try {
      await this.probe.religar();
      this.selo = await this.probe.carimbar();
      if (this.selo) {
        this.falhas = 0;
        log.info('listeners religados na página nova');
        return 'religado';
      }
    } catch (error) {
      log.error('falha ao religar os listeners', error);
    }

    this.falhas += 1;
    this.talvezDesistir('não foi possível religar os listeners');
    return 'falhou';
  }

  private talvezDesistir(motivo: string): void {
    if (this.falhas < this.options.maxFalhas) return;
    log.error(`vigia desistindo após ${this.falhas} tentativas: ${motivo}`);
    this.stop();
    (this.options.aoDesistir ?? derrubarProcesso)(motivo);
  }
}

/**
 * Último recurso: sair com código de erro para o supervisor (systemd) subir de
 * novo. Um boot custa ~1 min de captura, mas é infinitamente melhor que seguir
 * cego. `exit(1)` e não `exit(0)` para que `Restart=on-failure` também sirva.
 */
function derrubarProcesso(motivo: string): void {
  log.error(`encerrando o processo para o supervisor reiniciar: ${motivo}`);
  process.exit(1);
}
