import cron from 'node-cron';
import { format, addHours } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Start the scheduler that runs the given async function immediately,
 * then repeats every READ_INTERVAL_HOURS hours.
 *
 * @param {() => Promise<void>} runFn - The async function to schedule
 */
export function startScheduler(runFn) {
  const intervalHours = config.scheduler.intervalHours;

  // Build cron expression for every N hours
  // node-cron supports step values: "0 */3 * * *" = every 3 hours at minute 0
  const cronExpression = `0 */${intervalHours} * * *`;

  logger.info(`Agendador configurado: a cada ${intervalHours} hora(s) | Cron: "${cronExpression}"`);

  // Run immediately on startup
  logger.info('Iniciando primeira execução imediata...');
  runWithErrorHandling(runFn).then(() => {
    logNextRun(intervalHours);
  });

  // Schedule subsequent runs
  cron.schedule(cronExpression, async () => {
    const now = format(toZonedTime(new Date(), config.timezone), 'dd/MM/yyyy HH:mm:ss');
    logger.info(`[AGENDADOR] Execução programada iniciada às ${now}`);

    await runWithErrorHandling(runFn);
    logNextRun(intervalHours);
  }, {
    timezone: config.timezone,
  });

  logger.info('Agendador iniciado com sucesso.');
}

/**
 * Wrap runFn with error handling so failures don't crash the scheduler.
 */
async function runWithErrorHandling(runFn) {
  try {
    await runFn();
  } catch (err) {
    logger.error({ err }, '[AGENDADOR] Erro durante execução programada. Continuando...');
  }
}

/**
 * Log when the next run will be.
 */
function logNextRun(intervalHours) {
  const nextRun = addHours(new Date(), intervalHours);
  const nextRunFormatted = format(
    toZonedTime(nextRun, config.timezone),
    "dd/MM/yyyy 'às' HH:mm:ss"
  );
  logger.info(`[AGENDADOR] Próxima execução: ${nextRunFormatted}`);
}
