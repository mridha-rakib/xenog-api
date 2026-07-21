import { logger } from "../../core/logger/logger.js";
import { EventCancellationRefundService } from "./event-cancellation-refund.service.js";

const TICK_INTERVAL_MS = 30_000;
const RECONCILE_EVERY_TICKS = 10;

const service = new EventCancellationRefundService();
let tickCount = 0;

const tick = async (): Promise<void> => {
  const recovered = await service.recoverCancellationWorkflows();
  const processed = await service.processDueRefunds();

  tickCount += 1;
  const reconciled = tickCount % RECONCILE_EVERY_TICKS === 0
    ? await service.reconcileDueRefunds()
    : 0;

  if (recovered > 0 || processed > 0 || reconciled > 0) {
    logger.info({ recovered, processed, reconciled }, "Event cancellation refund worker tick completed");
  }
};

const scheduleNextTick = (): void => {
  setTimeout(() => {
    tick()
      .catch((error) => logger.error({ error }, "Event cancellation refund worker tick failed"))
      .finally(() => scheduleNextTick());
  }, TICK_INTERVAL_MS);
};

export const startEventCancellationRefundScheduler = (): void => {
  scheduleNextTick();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Event cancellation refund worker started");
};
