import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { ReportController } from "./report.controller.js";
import { reportValidation } from "./report.validation.js";

const router = Router();
const controller = new ReportController();

router.use(authenticate);
router.post("/", validate(reportValidation.create), catchAsync(controller.create));
router.use("/admin", authorizeRoles("admin"));
router.get("/admin", validate(reportValidation.list), catchAsync(controller.list));
router.get("/admin/:id", validate(reportValidation.params), catchAsync(controller.get));
router.patch("/admin/:id/action", validate(reportValidation.action), catchAsync(controller.action));
router.delete("/admin/:id", validate(reportValidation.params), catchAsync(controller.delete));

export const reportRoutes = router;
