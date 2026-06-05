import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { MoomentCreditPaymentController } from "./mooment-credit-payment.controller.js";
import { moomentCreditPaymentValidation } from "./mooment-credit-payment.validation.js";
import { StripeConnectController } from "./stripe-connect.controller.js";
import { stripeConnectValidation } from "./stripe-connect.validation.js";

const router = Router();
const stripeConnectController = new StripeConnectController();
const moomentCreditPaymentController = new MoomentCreditPaymentController();

router.get("/stripe-connect/return", catchAsync(stripeConnectController.returnToApp));
router.get("/stripe-connect/refresh", catchAsync(stripeConnectController.refreshOnboarding));

router.use(authenticate);

router.get("/mooment-credits/wallet", catchAsync(moomentCreditPaymentController.getWallet));
router.get(
  "/mooment-credits/checkout/:packageId",
  validate(moomentCreditPaymentValidation.getCheckoutQuote),
  catchAsync(moomentCreditPaymentController.getCheckoutQuote),
);
router.post(
  "/mooment-credits/purchases",
  validate(moomentCreditPaymentValidation.purchaseCredits),
  catchAsync(moomentCreditPaymentController.purchaseCredits),
);

router.get("/stripe-connect/account", catchAsync(stripeConnectController.getAccount));
router.post(
  "/stripe-connect/onboarding-link",
  validate(stripeConnectValidation.createOnboardingLink),
  catchAsync(stripeConnectController.createOnboardingLink),
);

export const paymentRoutes = router;
