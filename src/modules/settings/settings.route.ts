import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { SettingsController } from "./settings.controller.js";
import { settingsValidation } from "./settings.validation.js";

const router = Router();
const controller = new SettingsController();

router.get(
  "/legal-documents/:type",
  validate(settingsValidation.getLegalDocument),
  catchAsync(controller.getLegalDocument),
);

router.get(
  "/mooment-credit",
  catchAsync(controller.getMoomentCreditSettings),
);

router.use(authenticate, authorizeRoles("admin"));

router.put(
  "/legal-documents/:type",
  validate(settingsValidation.updateLegalDocument),
  catchAsync(controller.updateLegalDocument),
);

router.put(
  "/mooment-credit",
  validate(settingsValidation.updateMoomentCreditSettings),
  catchAsync(controller.updateMoomentCreditSettings),
);

router.get(
  "/pricing",
  catchAsync(controller.getPricingSettings),
);

router.put(
  "/pricing",
  validate(settingsValidation.updatePricingSettings),
  catchAsync(controller.updatePricingSettings),
);

export const settingsRoutes = router;
