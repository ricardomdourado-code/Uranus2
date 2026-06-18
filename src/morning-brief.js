import cron from 'node-cron';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { state } from './state.js';
import { config } from './config.js';
import { logger } from './logger.js';

export function initMorningBrief(getSocketFn) {
  // Every day at 07:00 America/Bahia
  cron.schedule('0 7 * * *', async () => {
    try {
      const sock = getSocketFn();
      if (!sock) {
        logger.warn('[MORNING BRIEF] WhatsApp não conectado. Pulando morning brief.');
        return;
      }

      const ownerJid = sock.user?.id;
      if (!ownerJid) {
        logger.warn('[MORNING BRIEF] ownerJid não disponível. Pulando.');
        return;
      }

      const chats = state.analyzedChats;
      if (!chats.length) {
        logger.warn('[MORNING BRIEF] Sem dados de chats. Pulando.');
        return;
      }

      const criticas = chats.filter(c => c.priority === 'CRITICA');
      const altas = chats.filter(c => c.priority === 'ALTA');
      const totalUnread = chats.reduce((s, c) => s + (c.unreadCount || 0), 0);

      const top5 = [...criticas, ...altas].slice(0, 5);

      const now = toZonedTime(new Date(), config.timezone);
      const dateStr = format(now, 'dd/MM/yyyy');

      const lines = [
        `🌅 *Morning Brief - Uranus2*`,
        `📅 Data: ${dateStr}`,
        ``,
        `🔴 *PRIORIDADES DO DIA:*`,
        ``,
      ];

      top5.forEach((c, i) => {
        lines.push(`${i + 1}. *${c.name}* — ${c.summary ? c.summary.split('\n')[0].slice(0, 80) : c.priorityReason || ''}`);
      });

      if (top5.length === 0) {
        lines.push('Nenhuma prioridade crítica ou alta no momento.');
      }

      lines.push(``);
      lines.push(`📊 Total: ${criticas.length} críticas | ${altas.length} altas | ${totalUnread} não lidas`);

      const message = lines.join('\n');

      await sock.sendMessage(ownerJid, { text: message });
      logger.info('[MORNING BRIEF] Morning brief enviado com sucesso!');
    } catch (err) {
      logger.error({ err }, '[MORNING BRIEF] Erro ao enviar morning brief');
    }
  }, {
    timezone: config.timezone,
  });

  logger.info('[MORNING BRIEF] Morning brief agendado para 07:00 America/Bahia');
}
