import cron from 'node-cron';
import { format, addHours, addMinutes } from 'date-fns';
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
  const intervalMinutes = config.scheduler.intervalMinutes;
  const intervalHours = config.scheduler.intervalHours;
  const useMinutes = intervalMinutes > 0;

  // node-cron step values: "*/10 * * * *" = every 10 minutes; "0 */3 * * *" = every 3h
  const cronExpression = useMinutes ? `*/${intervalMinutes} * * * *` : `0 */${intervalHours} * * *`;
  const label = useMinutes ? `${intervalMinutes} minuto(s)` : `${intervalHours} hora(s)`;

  logger.info(`Agendador configurado: a cada ${label} | Cron: "${cronExpression}"`);

  // Run immediately on startup
  logger.info('Iniciando primeira execução imediata...');
  runWithErrorHandling(runFn).then(() => {
    logNextRun(useMinutes, intervalMinutes, intervalHours);
  });

  // Schedule subsequent runs
  cron.schedule(cronExpression, async () => {
    const now = format(toZonedTime(new Date(), config.timezone), 'dd/MM/yyyy HH:mm:ss');
    logger.info(`[AGENDADOR] Execução programada iniciada às ${now}`);

    await runWithErrorHandling(runFn);
    logNextRun(useMinutes, intervalMinutes, intervalHours);
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
function logNextRun(useMinutes, intervalMinutes, intervalHours) {
  const nextRun = useMinutes
    ? addMinutes(new Date(), intervalMinutes)
    : addHours(new Date(), intervalHours);
  const nextRunFormatted = format(
    toZonedTime(nextRun, config.timezone),
    "dd/MM/yyyy 'às' HH:mm:ss"
  );
  logger.info(`[AGENDADOR] Próxima execução: ${nextRunFormatted}`);
}
