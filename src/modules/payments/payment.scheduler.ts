import { logger } from "../../core/logger/logger.js";
import { CheckoutInvoiceService } from "./checkout-invoice.service.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;

const checkoutPaymentService = new CheckoutPaymentService();
const checkoutInvoiceService = new CheckoutInvoiceService();

const tick = async (): Promise<void> => {
  await checkoutPaymentService.expireStaleReservations();
  await checkoutInvoiceService.processDueInvoices();
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
