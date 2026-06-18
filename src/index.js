import 'dotenv/config';
import { connectToWhatsApp, getSocket, storeEvents, getStoreSize, loadStore, flushStore } from './whatsapp.js';
import { getAllChats, getChatMessages, chatMentionsOwner } from './whatsapp.js';
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
    const chats = await getAllChats(sock, {
      activeDays: config.analysis.activeDays,
      max: config.analysis.maxChats,
    });
    logger.info(`${chats.length} conversas selecionadas para análise.`);

    if (chats.length === 0) {
      logger.warn('Nenhuma conversa encontrada. Tentando novamente em 5 minutos...');
      setTimeout(runAnalysisCycle, 5 * 60 * 1000);
      return;
    }

    lastAnalysisTime = Date.now();

    // Split out conversations the user moved to "Diversos": they are NOT sent to
    // GPT (saves tokens) and won't affect indicators, but still appear listed.
    // EXCEPTION: if a "Diversos" chat recently mentions the owner by name
    // (e.g. "@ricardo"), it is pulled back into the analysis automatically.
    const ignored = state.ignoredJids;
    const ownerAliases = [config.whatsapp.ownerName, 'Ricardo'].filter(Boolean);

    const mentionedJids = new Set();
    for (const c of chats) {
      if (ignored.has(c.jid) && chatMentionsOwner(c.jid, ownerAliases)) {
        mentionedJids.add(c.jid);
      }
    }
    if (mentionedJids.size > 0) {
      logger.info(`${mentionedJids.size} conversa(s) em "Diversos" mencionam você — retornando ao painel.`);
    }

    const isHidden = (jid) => ignored.has(jid) && !mentionedJids.has(jid);
    const toAnalyze = chats
      .filter((c) => !isHidden(c.jid))
      .map((c) => (mentionedJids.has(c.jid) ? { ...c, mentionedOwner: true } : c));
    const generalChats = chats
      .filter((c) => isHidden(c.jid))
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        priority: 'GERAL',
        priorityReason: 'Conversa marcada como não relevante (Geral).',
        summary: c.lastMessage || 'Sem resumo (conversa em Geral).',
        suggestedResponse: null,
        actionItems: [],
        requiresResponse: false,
        urgencyScore: 0,
        unreadCount: c.unreadCount || 0,
        lastMessageTime: c.lastMessageTime || null,
        type: c.type,
        ignored: true,
      }));

    if (ignored.size > 0) {
      logger.info(`${generalChats.length} conversa(s) em "Geral" (puladas no GPT) | ${toAnalyze.length} para análise.`);
    }

    logger.info(`Carregando mensagens (até ${config.analysis.maxMessagesPerChat} por conversa)...`);
    const chatsWithMessages = await Promise.all(
      toAnalyze.map(async (chat) => {
        const messages = await getChatMessages(sock, chat.jid, config.analysis.maxMessagesPerChat);
        return { ...chat, messages };
      })
    );

    logger.info('Enviando para análise GPT-4o...');
    const analyzed = await classifyAndSummarizeChats(chatsWithMessages);
    const analyzedChats = [...analyzed, ...generalChats];

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
    logger.info('Encerrando aplicação... salvando histórico.');
    try { flushStore(); } catch { /* ignore */ }
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
  loadStore(); // restore previously synced WhatsApp history from disk
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
    let settled = false;
    let lastTotal = -1;
    let stableTicks = 0;
    let timeout = null;

    // Heartbeat: prove the app is alive and show real progress every 20s.
    const heartbeat = setInterval(() => {
      const { chats, messages } = getStoreSize();
      logger.info(`⏳ Sincronizando... ${chats} conversas / ${messages} mensagens carregadas até agora.`);

      // If the totals stop growing for ~1 min (3 ticks) and we already have
      // data, the sync has effectively settled — proceed with the analysis.
      const total = chats + messages;
      if (total > 0 && total === lastTotal) {
        stableTicks += 1;
        if (stableTicks >= 3) {
          logger.info('✅ Sincronização estabilizada — prosseguindo com a análise.');
          settle();
        }
      } else {
        stableTicks = 0;
      }
      lastTotal = total;
    }, 20000);

    const settle = () => {
      if (!settled) {
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        resolve();
      }
    };

    // If store already has data from a previous run in this process, proceed immediately
    const { chats: existingChats, messages: existingMsgs } = getStoreSize();
    if (existingChats > 0 || existingMsgs > 0) {
      logger.info(`✅ Store já contém ${existingChats} conversas / ${existingMsgs} mensagens — prosseguindo.`);
      settle();
      return;
    }

    timeout = setTimeout(() => {
      const { chats, messages } = getStoreSize();
      logger.warn(`Timeout de sincronização — ${chats} conversas / ${messages} mensagens carregadas até agora.`);
      settle();
    }, 5 * 60 * 1000);

    storeEvents.on('history-ready', ({ chats, messages }) => {
      logger.info(`✅ Histórico pronto: ${chats} conversas / ${messages || 0} mensagens carregadas.`);
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
