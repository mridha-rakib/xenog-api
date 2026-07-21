import { logger } from "../../core/logger/logger.js";
import { EventRepository } from "../events/event.repository.js";
import { NotificationService } from "../notifications/notification.service.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import type { ICreatorPayout } from "./creator-payout.interface.js";
import { CreatorPayoutRepository } from "./creator-payout.repository.js";
import { StripeConnectService } from "./stripe-connect.service.js";

const TICK_INTERVAL_MS = 60_000;

const payoutRepository = new CreatorPayoutRepository();
const earningRepository = new CreatorEarningRepository();
const eventRepository = new EventRepository();
const stripeConnectService = new StripeConnectService();
const notificationService = new NotificationService();

const notify = async (userId: string, type: Parameters<typeof notificationService.sendSystemNotification>[1], message: string): Promise<void> => {
  try {
    await notificationService.sendSystemNotification(userId, type, message);
  } catch (err) {
    logger.warn({ err, userId, type }, "Failed to send payout notification — continuing");
  }
};

const processPayout = async (payout: ICreatorPayout): Promise<void> => {
  const payoutId = payout._id.toString();
  const creatorUserId = payout.creatorUserId.toString();
  const earningIds = payout.earningIds.map((id) => id.toString());
  const currency = payout.currency ?? "usd";
  const amountLabel = `${currency.toUpperCase()} ${payout.totalAmount.toFixed(2)}`;

  // Atomic claim: only proceed if the payout is still "pending".
  // This prevents duplicate processing if the scheduler tick overlaps with another instance.
  const claimed = await payoutRepository.markProcessingIfPending(payoutId);

  if (!claimed) {
    logger.info({ payoutId }, "Payout already claimed by another process — skipping");
    return;
  }

  logger.info(
    { payoutId, creatorUserId, payoutType: payout.payoutType, totalAmount: payout.totalAmount, currency },
    "Payout processing started",
  );

  await notify(
    creatorUserId,
    "payout_processing",
    `Your withdrawal of ${amountLabel} is now being processed.`,
  );

  try {
    const earnings = await earningRepository.findByIds(earningIds);
    const eventIds = [
      ...new Set(
        earnings
          .map((earning) => earning.eventId?.toString())
          .filter((eventId): eventId is string => Boolean(eventId)),
      ),
    ];
    const events = await eventRepository.findManyByIds(eventIds);
    const eventStatusById = new Map(events.map((event) => [event._id.toString(), event.status]));
    const blockedEarning = earnings.find((earning) => {
      const eventId = earning.eventId?.toString();
      return eventId ? eventStatusById.get(eventId) !== "completed" : false;
    });

    if (blockedEarning) {
      throw new Error("Payout contains event earnings that are no longer withdrawable.");
    }

    // Validate that Stripe is still ready (onboarding or debit card could have changed since request)
    const stripeAccountId = await stripeConnectService.validateReadyForPayout(creatorUserId, payout.payoutType);

    // Transfer funds from platform balance → connected account.
    // Idempotency key ensures a server crash and retry doesn't create a duplicate transfer.
    const stripeTransferId = await stripeConnectService.createTransfer({
      stripeAccountId,
      amountCents: Math.round(payout.totalAmount * 100),
      currency,
      transferGroup: payoutId,
      metadata: { payoutId, userId: creatorUserId, payoutType: payout.payoutType },
      idempotencyKey: `transfer-${payoutId}`,
    });

    logger.info({ payoutId, stripeTransferId }, "Stripe transfer created");

    // For instant debit card: also trigger an immediate payout to the connected account's debit card.
    if (payout.payoutType === "instant_debit_card") {
      const stripePayoutId = await stripeConnectService.createInstantPayoutOnConnectedAccount({
        stripeAccountId,
        amountCents: Math.round(payout.totalAmount * 100),
        currency,
        idempotencyKey: `instant-payout-${payoutId}`,
      });

      logger.info({ payoutId, stripePayoutId }, "Stripe instant payout triggered");
    }

    await payoutRepository.markCompleted(payoutId, stripeTransferId);

    logger.info({ payoutId, stripeTransferId, creatorUserId, payoutType: payout.payoutType }, "Payout completed");

    const arrivalNote = payout.payoutType === "instant_debit_card"
      ? "Funds should arrive within minutes."
      : "Funds should arrive within 1–3 business days.";

    await notify(
      creatorUserId,
      "payout_completed",
      `Your withdrawal of ${amountLabel} has been completed. ${arrivalNote}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Stripe transfer failed";

    logger.error({ payoutId, creatorUserId, payoutType: payout.payoutType, err }, "Payout failed — releasing earnings back to eligible");

    // Roll back atomically: mark payout failed and release reserved earnings in parallel.
    await Promise.all([
      payoutRepository.markFailed(payoutId, reason),
      earningRepository.releaseToEligible(earningIds),
    ]);

    await notify(
      creatorUserId,
      "payout_failed",
      `Your withdrawal of ${amountLabel} could not be completed. ${reason.slice(0, 120)}. Your funds have been returned to your available balance.`,
    );
  }
};

const tick = async (): Promise<void> => {
  const pending = await payoutRepository.findAllPending();

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, "Processing pending creator payouts");

  // Process all pending payouts concurrently. allSettled ensures one failure never blocks others.
  const results = await Promise.allSettled(pending.map((p) => processPayout(p)));

  const failed = results.filter((r) => r.status === "rejected");

  if (failed.length > 0) {
    logger.error({ failedCount: failed.length, totalCount: pending.length }, "Some payout processing tasks threw unexpectedly");
  }
};

const scheduleNextTick = (): void => {
  setTimeout(() => {
    tick()
      .catch((err) => logger.error({ err }, "Creator payout scheduler tick failed"))
      .finally(() => scheduleNextTick());
  }, TICK_INTERVAL_MS);
};

export const startCreatorPayoutScheduler = (): void => {
  scheduleNextTick();
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Creator payout scheduler started");
};
