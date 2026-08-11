/**
 * Sobe a sessão do WhatsApp no próprio processo (modo "custom code" do open-wa).
 *
 * Um processo só: aqui temos tanto os listeners quanto o conjunto completo de
 * métodos (getGroupMembers, getContact, getAllMessagesInChat), sem precisar de um
 * servidor Easy API separado.
 */

import { mkdirSync } from 'node:fs';
import { create, type Client, type ConfigObject } from '@open-wa/wa-automate';
import type { AppConfig } from './config';
import { createLogger } from './util/logger';

const log = createLogger('session');

/**
 * Chamado quando o open-wa recria a sessão após um crash da página.
 *
 * Recebe um Client NOVO — os listeners registrados no anterior morrem junto com
 * ele, então quem consome precisa religar tudo neste novo client.
 */
export type RestartHandler = (client: Client) => void | Promise<void>;

export async function startSession(
  config: AppConfig,
  onRestart?: RestartHandler,
): Promise<Client> {
  mkdirSync(config.sessionDataPath, { recursive: true });

  const userAgent = config.userAgent ?? defaultUserAgent();
  forceUserAgent(userAgent);

  const options: ConfigObject = {
    sessionId: config.sessionId,
    sessionDataPath: config.sessionDataPath,
    multiDevice: true,
    headless: config.headless,

    // Mantido por correção, mas a lib ignora esta chave fora do Docker —
    // ver forceUserAgent() abaixo, que é o que de fato tem efeito.
    customUserAgent: userAgent,

    // O Chromium que o puppeteer já baixou é suficiente; não é preciso ter
    // Chrome instalado. Estas duas opções ficam só como escape hatch.
    useChrome: config.useChrome,
    ...(config.chromePath ? { executablePath: config.chromePath } : {}),

    // ---------------------------------------------------------------------
    // Privacidade. blockCrashLogs já é true por padrão, mas fica explícito
    // porque é uma garantia que o projeto promete: bloqueia as chamadas para
    // dit.whatsapp.net/deidentified_telemetry e crashlogs.whatsapp.net.
    // skipUpdateCheck evita o GET de versão em raw.githubusercontent.com no boot.
    // Nenhum dado de mensagem sai da máquina em nenhuma das duas situações.
    // ---------------------------------------------------------------------
    blockCrashLogs: true,
    skipUpdateCheck: true,

    // Sem timeout no QR/auth: o QR fica no terminal até ser escaneado.
    qrTimeout: 0,
    authTimeout: 0,
    // Garante o QR desenhado no terminal. Com headless não há janela do
    // Chromium, então este é o único caminho para autenticar.
    qrLogSkip: false,

    // Este é um monitor de longa duração; cache em disco só incha o perfil.
    cacheEnabled: false,
    killProcessOnBrowserClose: true,
    disableSpins: true,
    logConsole: false,

    // A sessão precisa sobreviver a quedas de página do WhatsApp Web.
    // Atenção: o open-wa executa `create(config).then(config.restartOnCrash)`,
    // ou seja, isto TEM que ser uma função — ela recebe o Client novo. Passar
    // `true` reiniciaria o browser e perderia todos os listeners em silêncio.
    ...(onRestart ? { restartOnCrash: wrapRestart(onRestart) } : {}),
  };

  log.info('iniciando sessão', { sessionId: config.sessionId, headless: config.headless });
  const client = await create(options);
  log.info('sessão pronta');
  return client;
}

/**
 * Sobrescreve o user-agent embutido no @open-wa/wa-automate 4.76.0.
 *
 * Por que um monkey-patch em vez da opção `customUserAgent`: em
 * `controllers/initializer.js` a lib faz
 *
 *     let customUserAgent;
 *     if (config?.inDocker) { ...; customUserAgent = config.customUserAgent; }
 *     ...
 *     initPage(sessionId, config, qrManager, customUserAgent, spinner);
 *
 * ou seja, `config.customUserAgent` só é lido quando `inDocker` é true. Fora do
 * Docker a variável chega `undefined` em `initPage`, que então cai no default
 * `puppeteer_config.useragent`.
 *
 * Esse default é "WhatsApp/2.2147.16 Mozilla/5.0 (...) Chrome/104.0.0.0 ...",
 * e o WhatsApp Web hoje rejeita qualquer UA com o prefixo "WhatsApp/",
 * respondendo com a página "WhatsApp works with Google Chrome 100+" — mensagem
 * enganosa, já que a versão não é o problema. Verificado empiricamente: com o
 * prefixo, Chrome/104 e Chrome/131 falham igual; sem ele, ambos carregam.
 *
 * Como `browser.js` lê `puppeteer_config_1.useragent` do objeto de exports no
 * momento da chamada, reescrever essa propriedade antes do create() resolve.
 */
function forceUserAgent(userAgent: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteerConfig = require('@open-wa/wa-automate/dist/config/puppeteer.config') as {
    useragent: string;
  };
  puppeteerConfig.useragent = userAgent;
  log.debug('user-agent forçado', { userAgent });
}

/**
 * UA de Chrome comum, sem prefixo "WhatsApp/" e sem "HeadlessChrome".
 *
 * Se um dia o WhatsApp Web voltar a recusar, basta subir a versão do Chrome
 * aqui ou definir USER_AGENT no .env — não é preciso mexer em código.
 */
function defaultUserAgent(): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

function wrapRestart(handler: RestartHandler): RestartHandler {
  return async (client: Client) => {
    log.warn('sessão recriada após crash — religando coletores');
    try {
      await handler(client);
      log.info('coletores religados na nova sessão');
    } catch (error) {
      log.error('falha ao religar os coletores após o restart', error);
    }
  };
}

/** Encerra o browser sem derrubar o processo em caso de erro na parada. */
export async function stopSession(client: Client): Promise<void> {
  try {
    await client.kill('shutdown');
    log.info('sessão encerrada');
  } catch (error) {
    log.warn('falha ao encerrar a sessão de forma limpa', error);
  }
}
