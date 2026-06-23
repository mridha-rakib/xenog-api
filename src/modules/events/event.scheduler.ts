import { logger } from "../../core/logger/logger.js";
import { EventService } from "./event.service.js";

const TICK_INTERVAL_MS = 60_000;

const eventService = new EventService();

const tick = async (): Promise<void> => {
  const completed = await eventService.autoCompleteExpiredEvents();
  if (completed > 0) {
    logger.info({ count: completed }, "Event scheduler: auto-completed expired events");
  }

  const started = await eventService.autoStartScheduledEvents();
  if (started > 0) {
    logger.info({ count: started }, "Event scheduler: auto-started scheduled events");
  }
};

const scheduleNextTick = (): void => {
  setTimeout(() => {
    tick()
      .catch((err) => logger.error({ err }, "Event scheduler tick failed"))
      .finally(() => scheduleNextTick());
  }, TICK_INTERVAL_MS);
};

export const startEventScheduler = (): void => {
  scheduleNextTick();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Event scheduler started");
};
