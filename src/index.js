import 'dotenv/config';
import { connectToWhatsApp } from './whatsapp.js';
import { getAllChats, getChatMessages } from './whatsapp.js';
import { classifyAndSummarizeChats, generateExecutiveSummary } from './analyzer.js';
import { generateReport, saveReport, printReport } from './reporter.js';
import { startScheduler } from './scheduler.js';
import { config } from './config.js';
import { logger } from './logger.js';

let sock = null;

/**
 * Main analysis cycle: fetch all chats, analyze with GPT-4o, generate and save report.
 */
async function runAnalysisCycle() {
  if (!sock) {
    logger.warn('WhatsApp não conectado. Pulando ciclo de análise.');
    return;
  }

  logger.info('─'.repeat(60));
  logger.info('🔍 Iniciando ciclo de leitura e análise...');

  try {
    // 1. Fetch all chats
    const chats = await getAllChats(sock);
    logger.info(`${chats.length} conversas encontradas.`);

    if (chats.length === 0) {
      logger.warn('Nenhuma conversa encontrada. O WhatsApp pode ainda estar sincronizando.');
      return;
    }

    // 2. Fetch messages for each chat
    logger.info(`Carregando mensagens (até ${config.analysis.maxMessagesPerChat} por conversa)...`);
    const chatsWithMessages = await Promise.all(
      chats.map(async (chat) => {
        const messages = await getChatMessages(sock, chat.jid, config.analysis.maxMessagesPerChat);
        return { ...chat, messages };
      })
    );

    // 3. Analyze with GPT-4o
    logger.info('Enviando para análise GPT-4o...');
    const analyzedChats = await classifyAndSummarizeChats(chatsWithMessages);

    // 4. Generate executive summary
    const executiveSummary = await generateExecutiveSummary(analyzedChats);

    // 5. Build report
    const reportText = generateReport(analyzedChats, executiveSummary);

    // 6. Print to terminal
    printReport(reportText);

    // 7. Save to file
    if (config.reports.save) {
      const filePath = saveReport(reportText);
      logger.info(`Relatório salvo: ${filePath}`);
    }

    logger.info('✅ Ciclo de análise concluído.');
    logger.info('─'.repeat(60));
  } catch (err) {
    logger.error({ err }, 'Erro durante ciclo de análise');
  }
}

/**
 * Graceful shutdown handler.
 */
function setupGracefulShutdown() {
  const shutdown = () => {
    logger.info('Encerrando aplicação...');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Application entry point.
 */
async function main() {
  logger.info('═'.repeat(60));
  logger.info('  Uranus2 WhatsApp Automação — Iniciando');
  logger.info(`  Proprietário: ${config.whatsapp.ownerName}`);
  logger.info(`  Modelo IA: ${config.openai.model}`);
  logger.info(`  Ciclo: a cada ${config.scheduler.intervalHours}h`);
  logger.info('═'.repeat(60));

  setupGracefulShutdown();

  try {
    logger.info('Conectando ao WhatsApp...');
    sock = await connectToWhatsApp();

    logger.info('Aguardando sincronização inicial (10s)...');
    await new Promise((r) => setTimeout(r, 10000));

    logger.info('🚀 Iniciando primeira leitura profunda...');
    startScheduler(runAnalysisCycle);
  } catch (err) {
    logger.error({ err }, 'Erro fatal na inicialização');
    process.exit(1);
  }
}

main();
