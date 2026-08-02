import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { DashboardController } from "./dashboard.controller.js";
import { dashboardValidation } from "./dashboard.validation.js";

const router = Router();
const controller = new DashboardController();

// Admin-only, read-only analytics. Never consumed by the mobile app.
router.get(
  "/admin/overview",
  authenticate,
  authorizeRoles("admin"),
  validate(dashboardValidation.overview),
  catchAsync(controller.getOverview),
);

export const dashboardRoutes = router;
