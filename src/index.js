import 'dotenv/config';
import { connectToWhatsApp, getSocket, storeEvents } from './whatsapp.js';
import { getAllChats, getChatMessages } from './whatsapp.js';
import { classifyAndSummarizeChats, generateExecutiveSummary } from './analyzer.js';
import { generateReport, saveReport, printReport } from './reporter.js';
import { startScheduler } from './scheduler.js';
import { initMorningBrief } from './morning-brief.js';
import { loadPersistedData } from './state.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { initServer, updateReportData } from './server.js';
import { state } from './state.js';

async function runAnalysisCycle() {
  // Always use the latest socket instance
  const sock = getSocket();
  if (!sock) {
    logger.warn('WhatsApp não conectado. Pulando ciclo de análise.');
    return;
  }

  logger.info('─'.repeat(60));
  logger.info('🔍 Iniciando ciclo de leitura e análise...');

  try {
    const chats = await getAllChats(sock);
    logger.info(`${chats.length} conversas encontradas.`);

    if (chats.length === 0) {
      logger.warn('Nenhuma conversa encontrada. Tentando novamente no próximo ciclo.');
      return;
    }

    logger.info(`Carregando mensagens (até ${config.analysis.maxMessagesPerChat} por conversa)...`);
    const chatsWithMessages = await Promise.all(
      chats.map(async (chat) => {
        const messages = await getChatMessages(sock, chat.jid, config.analysis.maxMessagesPerChat);
        return { ...chat, messages };
      })
    );

    logger.info('Enviando para análise GPT-4o...');
    const analyzedChats = await classifyAndSummarizeChats(chatsWithMessages);

    const executiveSummary = await generateExecutiveSummary(analyzedChats);
    const reportText = generateReport(analyzedChats, executiveSummary);

    printReport(reportText);

    if (config.reports.save) {
      const filePath = saveReport(reportText);
      logger.info(`Relatório salvo: ${filePath}`);
    }

    updateReportData(analyzedChats);

    logger.info('✅ Ciclo de análise concluído.');
    logger.info('─'.repeat(60));
  } catch (err) {
    logger.error({ err }, 'Erro durante ciclo de análise');
  }
}

function setupGracefulShutdown() {
  const shutdown = () => {
    logger.info('Encerrando aplicação...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  logger.info('═'.repeat(60));
  logger.info('  Uranus2 WhatsApp Automação — Iniciando');
  logger.info(`  Proprietário: ${config.whatsapp.ownerName}`);
  logger.info(`  Modelo IA: ${config.openai.model}`);
  logger.info(`  Ciclo: a cada ${config.scheduler.intervalHours}h`);
  logger.info('═'.repeat(60));

  setupGracefulShutdown();
  initServer(config.server?.port || 3000);
  await loadPersistedData();
  initMorningBrief(getSocket);

  // Keep trying to connect until successful
  const waitForConnection = () => new Promise((resolve) => {
    const tryConnect = async () => {
      try {
        await connectToWhatsApp();
        state.connected = true;
        resolve();
      } catch (err) {
        logger.warn('Falha na conexão, tentando novamente em 10s...');
        setTimeout(tryConnect, 10000);
      }
    };
    tryConnect();
  });

  logger.info('Conectando ao WhatsApp...');
  await waitForConnection();

  logger.info('Aguardando histórico do WhatsApp...');
  await new Promise((resolve) => {
    // Resolve as soon as chats are loaded, or after 5 min max
    const timeout = setTimeout(() => {
      logger.warn('Timeout de sincronização — iniciando com o que foi carregado.');
      resolve();
    }, 5 * 60 * 1000);
    storeEvents.once('history-ready', ({ chats }) => {
      logger.info(`✅ Histórico pronto: ${chats} conversas carregadas.`);
      clearTimeout(timeout);
      // Wait 10s more for remaining chunks
      setTimeout(resolve, 10000);
    });
  });

  logger.info('🚀 Iniciando primeira leitura profunda...');
  startScheduler(runAnalysisCycle);
}

main();
