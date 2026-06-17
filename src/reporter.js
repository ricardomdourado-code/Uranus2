import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  orange: '\x1b[33m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  dim: '\x1b[2m',
};

const PRIORITY_CONFIG = {
  CRITICA: {
    emoji: '🔴',
    label: 'PRIORIDADE CRÍTICA',
    criterion: 'Financeiro urgente, RH/Decisões executivas, Clientes/Parceiros estratégicos',
    color: COLORS.red,
    summaryEmoji: '🔴',
    summaryLabel: 'Críticas',
  },
  ALTA: {
    emoji: '🟠',
    label: 'PRIORIDADE ALTA',
    criterion: 'Operações de produção, Pendências de equipe, Aprovações necessárias',
    color: COLORS.orange,
    summaryEmoji: '🟠',
    summaryLabel: 'Altas',
  },
  MEDIA: {
    emoji: '🟡',
    label: 'PRIORIDADE MÉDIA',
    criterion: 'Atualizações operacionais, Relatórios, Coordenação de equipe',
    color: COLORS.yellow,
    summaryEmoji: '🟡',
    summaryLabel: 'Médias',
  },
  BAIXA: {
    emoji: '🟢',
    label: 'PRIORIDADE BAIXA',
    criterion: 'Pessoal, Social, Informativo, Sem urgência',
    color: COLORS.green,
    summaryEmoji: '🟢',
    summaryLabel: 'Baixas',
  },
};

const LINE_FULL = '='.repeat(80);
const LINE_SECTION = '─'.repeat(80);
const LINE_DOUBLE = '═'.repeat(80);

/**
 * Format a timestamp for display.
 */
function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  try {
    return format(toZonedTime(timestamp, config.timezone), 'HH:mm');
  } catch {
    return 'N/A';
  }
}

/**
 * Build the full text report.
 * @param {Array} analyzedChats - Array from analyzer.js
 * @param {string} executiveSummary - Executive summary text
 * @returns {string}
 */
export function generateReport(analyzedChats, executiveSummary = '') {
  const now = toZonedTime(new Date(), config.timezone);
  const nowFormatted = format(now, "dd/MM/yyyy, HH:mm:ss");

  const totalUnread = analyzedChats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);

  const lines = [];

  // Header
  lines.push(LINE_FULL);
  lines.push('  RELATÓRIO DE PRIORIDADES DE RESPOSTA - WHATSAPP');
  lines.push(`  Gerado em: ${nowFormatted}`);
  lines.push(`  Total de conversas analisadas: ${analyzedChats.length}`);
  lines.push(`  Total de mensagens não lidas: ${totalUnread}`);
  lines.push(LINE_FULL);
  lines.push('');

  // Sections by priority
  const priorities = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'];

  for (const priority of priorities) {
    const cfg = PRIORITY_CONFIG[priority];
    const chats = analyzedChats.filter((c) => c.priority === priority);

    if (chats.length === 0) continue;

    const sectionUnread = chats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);

    lines.push(`${cfg.emoji} ${cfg.label}`);
    lines.push(`Critério: ${cfg.criterion}`);
    lines.push(LINE_SECTION);
    lines.push('');

    chats.forEach((chat, index) => {
      const timeStr = formatTime(chat.lastMessageTime);
      const typeStr = chat.type || 'Contato';

      lines.push(`  ${index + 1}. ${chat.name.toUpperCase()}`);
      lines.push(`     Tipo: ${typeStr} | Não lidas: ${chat.unreadCount || 0} | Horário: ${timeStr}`);

      if (chat.summary) {
        // Word-wrap summary at ~70 chars for readability
        const summaryLines = wrapText(chat.summary, 70);
        lines.push(`     Resumo: ${summaryLines[0]}`);
        for (let i = 1; i < summaryLines.length; i++) {
          lines.push(`             ${summaryLines[i]}`);
        }
      }

      if (chat.suggestedResponse) {
        lines.push(`     💬 SUGESTÃO DE RESPOSTA:`);
        const responseLines = wrapText(chat.suggestedResponse, 65);
        lines.push(`     "${responseLines[0]}`);
        for (let i = 1; i < responseLines.length; i++) {
          lines.push(`      ${responseLines[i]}`);
        }
        // Close the quote on the last line if not already there
        const lastLine = lines[lines.length - 1];
        if (!lastLine.endsWith('"')) {
          lines[lines.length - 1] = lastLine + '"';
        }
      }

      if (chat.actionItems && chat.actionItems.length > 0) {
        lines.push(`     📋 AÇÕES:`);
        for (const action of chat.actionItems) {
          lines.push(`     - ${action}`);
        }
      }

      lines.push('');
    });

    lines.push(`  Total neste nível: ${chats.length} conversa(s) | ${sectionUnread} mensagens não lidas`);
    lines.push(LINE_DOUBLE);
    lines.push('');
  }

  // Stats summary
  const stats = {};
  for (const p of priorities) {
    stats[p] = {
      count: analyzedChats.filter((c) => c.priority === p).length,
      unread: analyzedChats.filter((c) => c.priority === p).reduce((s, c) => s + (c.unreadCount || 0), 0),
    };
  }

  lines.push(LINE_FULL);
  lines.push('RESUMO EXECUTIVO');
  lines.push(LINE_FULL);

  for (const p of priorities) {
    const cfg = PRIORITY_CONFIG[p];
    const label = cfg.summaryLabel.padEnd(10);
    const count = String(stats[p].count).padStart(3);
    const unread = stats[p].unread;
    lines.push(`${cfg.summaryEmoji} ${label}   ${count} conversa(s) | ${unread} msgs não lidas`);
  }

  lines.push(LINE_FULL);

  if (executiveSummary) {
    const summaryLines = executiveSummary.split('\n');
    for (const line of summaryLines) {
      lines.push(line);
    }
    lines.push(LINE_FULL);
  }

  // Immediate actions
  lines.push('AÇÕES IMEDIATAS RECOMENDADAS:');

  const actionChats = analyzedChats
    .filter((c) => c.requiresResponse || (c.actionItems && c.actionItems.length > 0))
    .slice(0, 5);

  if (actionChats.length === 0) {
    lines.push('  Nenhuma ação imediata identificada.');
  } else {
    actionChats.forEach((chat, i) => {
      const firstAction = chat.actionItems?.[0] || `Responder ${chat.name}`;
      lines.push(`${i + 1}. [${chat.priority}] ${chat.name}: ${firstAction}`);
    });
  }

  lines.push(LINE_FULL);

  return lines.join('\n');
}

/**
 * Save report to a timestamped file.
 * @param {string} reportText
 * @param {string} dir
 * @returns {string} - File path
 */
export function saveReport(reportText, dir) {
  const reportsDir = dir || config.reports.dir;
  mkdirSync(reportsDir, { recursive: true });

  const now = toZonedTime(new Date(), config.timezone);
  const timestamp = format(now, 'yyyyMMdd_HHmmss');
  const filename = `whatsapp_prioridades_${timestamp}.txt`;
  const filepath = join(reportsDir, filename);

  writeFileSync(filepath, reportText, 'utf-8');
  logger.info(`Relatório salvo em: ${filepath}`);

  return filepath;
}

/**
 * Print report to console with ANSI colors.
 * @param {string} reportText
 */
export function printReport(reportText) {
  const lines = reportText.split('\n');

  for (const line of lines) {
    let coloredLine = line;

    if (line.startsWith('=') && line.length > 20) {
      coloredLine = `${COLORS.cyan}${COLORS.bold}${line}${COLORS.reset}`;
    } else if (line.startsWith('═') && line.length > 20) {
      coloredLine = `${COLORS.dim}${line}${COLORS.reset}`;
    } else if (line.startsWith('─') && line.length > 20) {
      coloredLine = `${COLORS.dim}${line}${COLORS.reset}`;
    } else if (line.includes('🔴')) {
      coloredLine = `${COLORS.red}${COLORS.bold}${line}${COLORS.reset}`;
    } else if (line.includes('🟠')) {
      coloredLine = `${COLORS.orange}${COLORS.bold}${line}${COLORS.reset}`;
    } else if (line.includes('🟡')) {
      coloredLine = `${COLORS.yellow}${COLORS.bold}${line}${COLORS.reset}`;
    } else if (line.includes('🟢')) {
      coloredLine = `${COLORS.green}${COLORS.bold}${line}${COLORS.reset}`;
    } else if (line.includes('💬 SUGESTÃO')) {
      coloredLine = `${COLORS.cyan}${line}${COLORS.reset}`;
    } else if (line.includes('📋 AÇÕES')) {
      coloredLine = `${COLORS.cyan}${line}${COLORS.reset}`;
    } else if (line.startsWith('  RELATÓRIO')) {
      coloredLine = `${COLORS.bold}${COLORS.white}${line}${COLORS.reset}`;
    } else if (line.startsWith('RESUMO EXECUTIVO') || line.startsWith('AÇÕES IMEDIATAS')) {
      coloredLine = `${COLORS.bold}${COLORS.white}${line}${COLORS.reset}`;
    } else if (line.match(/^\s+\d+\. [A-Z]/)) {
      coloredLine = `${COLORS.bold}${line}${COLORS.reset}`;
    }

    console.log(coloredLine);
  }
}

/**
 * Simple word-wrap utility.
 */
function wrapText(text, maxWidth) {
  if (!text) return [''];
  if (text.length <= maxWidth) return [text];

  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).trim().length <= maxWidth) {
      current = (current + ' ' + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines.length > 0 ? lines : [''];
}
