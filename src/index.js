import 'dotenv/config';
import { connectToWhatsApp, getSocket, storeEvents, getStoreSize } from './whatsapp.js';
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

let lastAnalysisTime = 0;

async function runAnalysisCycle() {
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
      logger.warn('Nenhuma conversa encontrada. Tentando novamente em 5 minutos...');
      setTimeout(runAnalysisCycle, 5 * 60 * 1000);
      return;
    }

    lastAnalysisTime = Date.now();

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
    // If store already has data from a previous run in this process, proceed immediately
    const { chats: existingChats, messages: existingMsgs } = getStoreSize();
    if (existingChats > 0 || existingMsgs > 0) {
      logger.info(`✅ Store já contém ${existingChats} conversas / ${existingMsgs} mensagens — prosseguindo.`);
      resolve();
      return;
    }

    let settled = false;
    const settle = () => {
      if (!settled) { settled = true; resolve(); }
    };

    const timeout = setTimeout(() => {
      const { chats, messages } = getStoreSize();
      logger.warn(`Timeout de sincronização — ${chats} conversas / ${messages} mensagens carregadas até agora.`);
      settle();
    }, 5 * 60 * 1000);

    storeEvents.on('history-ready', ({ chats, messages }) => {
      logger.info(`✅ Histórico pronto: ${chats} conversas / ${messages || 0} mensagens carregadas.`);
      clearTimeout(timeout);
      // Wait 10s more for remaining chunks
      setTimeout(settle, 10000);
    });
  });

  logger.info('🚀 Iniciando primeira leitura profunda...');
  startScheduler(runAnalysisCycle);

  // On every reconnection: if store has data and no recent analysis, run immediately
  storeEvents.on('socket-open', () => {
    state.connected = true;
    const { chats } = getStoreSize();
    const minutesSinceLast = (Date.now() - lastAnalysisTime) / 60000;
    if (chats > 0 && minutesSinceLast > 30) {
      logger.info(`Reconectado com ${chats} conversas no store — agendando análise em 15s...`);
      setTimeout(runAnalysisCycle, 15000);
    }
  });

  // If history-ready fires after startup (e.g., second sync chunk), run analysis
  storeEvents.on('history-ready', ({ chats }) => {
    if (lastAnalysisTime > 0) return; // already ran at least once
    const minutesSinceLast = (Date.now() - lastAnalysisTime) / 60000;
    if (chats > 0 && minutesSinceLast > 10) {
      logger.info(`Novo lote de histórico detectado (${chats} conversas) — agendando análise em 15s...`);
      setTimeout(runAnalysisCycle, 15000);
    }
  });
}

main();
