import 'dotenv/config';
import { resolve } from 'path';

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  whatsapp: {
    ownerName: process.env.WA_OWNER_NAME || 'Ricardo Dourado',
    authDir: resolve('./data/auth'),
  },
  scheduler: {
    deepReadHour: parseInt(process.env.DEEP_READ_HOUR || '8', 10),
    intervalHours: parseInt(process.env.READ_INTERVAL_HOURS || '3', 10),
  },
  analysis: {
    maxMessagesPerChat: parseInt(process.env.MAX_MESSAGES_PER_CHAT || '10', 10),
    batchSize: 10,
    // Only analyze conversations active within this many days (or with unread msgs).
    activeDays: parseInt(process.env.ANALYSIS_ACTIVE_DAYS || '7', 10),
    // Cap the number of conversations sent to GPT per cycle (cost/rate control).
    maxChats: parseInt(process.env.ANALYSIS_MAX_CHATS || '80', 10),
  },
  reports: {
    save: process.env.SAVE_REPORTS !== 'false',
    dir: resolve(process.env.REPORTS_DIR || './reports'),
  },
  timezone: process.env.TZ || 'America/Bahia',
};

if (!config.openai.apiKey) {
  console.warn('[CONFIG] AVISO: OPENAI_API_KEY não definida. Análise GPT não funcionará.');
}
