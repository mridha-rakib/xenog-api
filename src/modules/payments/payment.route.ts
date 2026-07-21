import { Router } from "express";
import rateLimit from "express-rate-limit";
import { catchAsync } from "../../core/http/catch-async.js";
import { ApiResponse } from "../../core/http/api-response.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { CheckoutPaymentController } from "./checkout-payment.controller.js";
import { checkoutPaymentValidation } from "./checkout-payment.validation.js";
import { StripeConnectController } from "./stripe-connect.controller.js";
import { stripeConnectValidation } from "./stripe-connect.validation.js";
import { CreatorEarningController } from "./creator-earning.controller.js";
import { creatorEarningValidation } from "./creator-earning.validation.js";
import { PayoutSettingsController } from "./payout-settings.controller.js";
import { payoutSettingsValidation } from "./payout-settings.validation.js";
import { EventCancellationRefundController } from "./event-cancellation-refund.controller.js";

const router = Router();
const stripeConnectController = new StripeConnectController();
const checkoutPaymentController = new CheckoutPaymentController();
const creatorEarningController = new CreatorEarningController();
const payoutSettingsController = new PayoutSettingsController();
const eventCancellationRefundController = new EventCancellationRefundController();
const ticketScanRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => req.authUser?.id ?? "unauthenticated",
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    ApiResponse.error(res, {
      statusCode: 429,
      message: "Too many invalid ticket attempts. Please try again shortly.",
      details: { code: "TICKET_SCAN_RATE_LIMITED" },
    });
  },
});

router.get("/stripe-connect/return", catchAsync(stripeConnectController.returnToApp));
router.get("/stripe-connect/refresh", catchAsync(stripeConnectController.refreshOnboarding));
router.post("/stripe/webhook", catchAsync(checkoutPaymentController.stripeWebhook));

router.use(authenticate);

router.post(
  "/checkout-intents",
  validate(checkoutPaymentValidation.createIntent),
  catchAsync(checkoutPaymentController.createIntent),
);
router.post(
  "/checkout-orders/:orderId/confirm",
  validate(checkoutPaymentValidation.orderParams),
  catchAsync(checkoutPaymentController.confirmOrder),
);
router.post(
  "/checkout-orders/:orderId/refund",
  validate(checkoutPaymentValidation.orderParams),
  catchAsync(checkoutPaymentController.refundOrder),
);
router.post(
  "/checkout-orders/:orderId/cancel",
  validate(checkoutPaymentValidation.orderParams),
  catchAsync(checkoutPaymentController.cancelOrder),
);

router.get(
  "/ticket-purchase-counts/:eventId",
  validate(checkoutPaymentValidation.eventParams),
  catchAsync(checkoutPaymentController.getMyTicketPurchaseCounts),
);
router.get(
  "/event-ticket-stats/:id",
  validate(checkoutPaymentValidation.idParam),
  catchAsync(checkoutPaymentController.getEventTicketStats),
);
router.get(
  "/event-ticket-stat-items/:id",
  validate(checkoutPaymentValidation.ticketStatItems),
  catchAsync(checkoutPaymentController.getEventTicketStatItems),
);
router.get(
  "/event-attendance-summary/:eventId",
  validate(checkoutPaymentValidation.eventParams),
  catchAsync(checkoutPaymentController.getEventAttendanceSummary),
);
router.get(
  "/event-going-items/:eventId",
  validate(checkoutPaymentValidation.publicGoingItems),
  catchAsync(checkoutPaymentController.getPublicEventGoingItems),
);
router.get("/ticket-wallet", catchAsync(checkoutPaymentController.getMyTicketWallet));

router.get(
  "/admin/refund-batches",
  authorizeRoles("admin"),
  catchAsync(eventCancellationRefundController.listBatches),
);
router.get(
  "/admin/refund-batches/:batchId",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundBatchParams),
  catchAsync(eventCancellationRefundController.getBatchDetails),
);
router.post(
  "/admin/refund-batches/:batchId/retry",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundBatchParams),
  catchAsync(eventCancellationRefundController.retryBatch),
);
router.post(
  "/admin/refund-batches/:batchId/reconcile",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundBatchParams),
  catchAsync(eventCancellationRefundController.reconcileBatch),
);
router.post(
  "/admin/refund-batches/:batchId/resume",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundBatchParams),
  catchAsync(eventCancellationRefundController.resumeBatch),
);
router.post(
  "/admin/refunds/:refundId/retry",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundItemParams),
  catchAsync(eventCancellationRefundController.retryRefund),
);
router.post(
  "/admin/refunds/:refundId/reconcile",
  authorizeRoles("admin"),
  validate(checkoutPaymentValidation.refundItemParams),
  catchAsync(eventCancellationRefundController.reconcileRefund),
);
router.post(
  "/ticket-shares",
  validate(checkoutPaymentValidation.shareTicket),
  catchAsync(checkoutPaymentController.shareTicket),
);
router.post(
  "/ticket-scans",
  ticketScanRateLimit,
  validate(checkoutPaymentValidation.scanTicket),
  catchAsync(checkoutPaymentController.scanTicket),
);
router.delete(
  "/ticket-shares/:shareId",
  validate(checkoutPaymentValidation.shareParams),
  catchAsync(checkoutPaymentController.cancelTicketShare),
);

router.get("/creator-earnings", catchAsync(creatorEarningController.getMyEarnings));
router.get(
  "/creator-earnings/events/:eventId",
  validate(creatorEarningValidation.getEventEarnings),
  catchAsync(creatorEarningController.getEarningsByEvent),
);
router.get("/creator-payouts", catchAsync(creatorEarningController.getMyPayouts));
router.post(
  "/creator-earnings/withdraw",
  validate(creatorEarningValidation.requestWithdrawal),
  catchAsync(creatorEarningController.requestWithdrawal),
);

router.get("/stripe-connect/account", catchAsync(stripeConnectController.getAccount));
router.post(
  "/stripe-connect/onboarding-link",
  validate(stripeConnectValidation.createOnboardingLink),
  catchAsync(stripeConnectController.createOnboardingLink),
);

router.get("/payout-settings", catchAsync(payoutSettingsController.getPayoutSettings));
router.patch(
  "/payout-settings",
  validate(payoutSettingsValidation.updatePayoutSettings),
  catchAsync(payoutSettingsController.updatePayoutSettings),
);

export const paymentRoutes = router;
