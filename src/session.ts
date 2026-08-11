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

  const options: ConfigObject = {
    sessionId: config.sessionId,
    sessionDataPath: config.sessionDataPath,
    multiDevice: true,
    headless: config.headless,

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
