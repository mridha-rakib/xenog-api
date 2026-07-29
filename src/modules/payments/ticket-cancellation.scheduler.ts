import { logger } from "../../core/logger/logger.js";
import { TicketCancellationService } from "./ticket-cancellation.service.js";

const TICK_INTERVAL_MS = 30_000;
const RECONCILE_EVERY_TICKS = 10;

const service = new TicketCancellationService();
let tickCount = 0;

const tick = async (): Promise<void> => {
  const processed = await service.processDueRefunds();

  tickCount += 1;
  const reconciled = tickCount % RECONCILE_EVERY_TICKS === 0
    ? await service.reconcileDueRefunds()
    : 0;

  if (processed > 0 || reconciled > 0) {
    logger.info({ processed, reconciled }, "Ticket cancellation refund worker tick completed");
  }
};

const scheduleNextTick = (): void => {
  setTimeout(() => {
    tick()
      .catch((error) => logger.error({ error }, "Ticket cancellation refund worker tick failed"))
      .finally(() => scheduleNextTick());
  }, TICK_INTERVAL_MS);
};

export const startTicketCancellationScheduler = (): void => {
  scheduleNextTick();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Ticket cancellation refund worker started");
};
