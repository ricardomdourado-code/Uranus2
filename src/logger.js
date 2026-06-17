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

export default logger;
