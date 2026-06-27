import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { CheckoutPaymentController } from "./checkout-payment.controller.js";
import { checkoutPaymentValidation } from "./checkout-payment.validation.js";
import { StripeConnectController } from "./stripe-connect.controller.js";
import { stripeConnectValidation } from "./stripe-connect.validation.js";
import { CreatorEarningController } from "./creator-earning.controller.js";
import { creatorEarningValidation } from "./creator-earning.validation.js";
import { PayoutSettingsController } from "./payout-settings.controller.js";
import { payoutSettingsValidation } from "./payout-settings.validation.js";

const router = Router();
const stripeConnectController = new StripeConnectController();
const checkoutPaymentController = new CheckoutPaymentController();
const creatorEarningController = new CreatorEarningController();
const payoutSettingsController = new PayoutSettingsController();

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
router.get("/ticket-wallet", catchAsync(checkoutPaymentController.getMyTicketWallet));
router.post(
  "/ticket-shares",
  validate(checkoutPaymentValidation.shareTicket),
  catchAsync(checkoutPaymentController.shareTicket),
);
router.post(
  "/ticket-scans",
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
