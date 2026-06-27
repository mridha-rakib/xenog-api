import { logger } from "../../core/logger/logger.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;

const checkoutPaymentService = new CheckoutPaymentService();

const tick = async (): Promise<void> => {
  await checkoutPaymentService.expireStaleReservations();
};

const scheduleNextTick = (): void => {
  setTimeout(() => {
    tick()
      .catch((err) => logger.error({ err }, "Payment scheduler tick failed"))
      .finally(() => scheduleNextTick());
  }, TICK_INTERVAL_MS);
};

export const startPaymentScheduler = (): void => {
  scheduleNextTick();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Payment scheduler started");
};
