import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { AnalyticsController } from "./analytics.controller.js";
import { analyticsValidation } from "./analytics.validation.js";

const router = Router();
const controller = new AnalyticsController();

// Admin-only, read-only analytics. Never consumed by the mobile app.
router.get(
  "/admin/overview",
  authenticate,
  authorizeRoles("admin"),
  validate(analyticsValidation.overview),
  catchAsync(controller.getOverview),
);

export const analyticsRoutes = router;
