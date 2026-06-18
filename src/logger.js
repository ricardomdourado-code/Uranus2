import pino from 'pino';
import { config } from './config.js';

const transport = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: `SYS:dd/MM/yyyy HH:mm:ss`,
    ignore: 'pid,hostname',
    messageFormat: '{msg}',
  },
});

export const logger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

// Dedicated logger for Baileys internals. Set to 'silent' to suppress the
// harmless but noisy decrypt/prekey/resync errors that occur while syncing
// old history. Override with BAILEYS_LOG_LEVEL=warn for debugging.
export const baileysLogger = pino(
  {
    level: process.env.BAILEYS_LOG_LEVEL || 'silent',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

export default logger;
