import { Router } from "express";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { catchAsync } from "../../core/http/catch-async.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { AuthController } from "./auth.controller.js";
import { authValidation } from "./auth.validation.js";

const router = Router();
const controller = new AuthController();

router.post("/register", validate(authValidation.register), catchAsync(controller.register));
router.post("/login", validate(authValidation.login), catchAsync(controller.login));
router.post("/admin/login", validate(authValidation.login), catchAsync(controller.adminLogin));
router.post("/verify-email", validate(authValidation.verifyEmail), catchAsync(controller.verifyEmail));
router.post("/refresh", validate(authValidation.refresh), catchAsync(controller.refresh));
router.patch("/password", authenticate, validate(authValidation.changePassword), catchAsync(controller.changePassword));
router.post(
  "/resend-verification",
  validate(authValidation.resendVerification),
  catchAsync(controller.resendVerificationCode),
);
router.post(
  "/forgot-password",
  validate(authValidation.requestPasswordReset),
  catchAsync(controller.requestPasswordReset),
);
router.post(
  "/validate-reset-code",
  validate(authValidation.validatePasswordResetCode),
  catchAsync(controller.validatePasswordResetCode),
);
router.post("/reset-password", validate(authValidation.resetPassword), catchAsync(controller.resetPassword));
router.get("/me", authenticate, catchAsync(controller.me));
router.patch("/me", authenticate, validate(authValidation.updateProfile), catchAsync(controller.updateMe));
router.delete("/me", authenticate, catchAsync(controller.deleteMe));
router.post("/logout", authenticate, catchAsync(controller.logout));

export const authRoutes = router;
