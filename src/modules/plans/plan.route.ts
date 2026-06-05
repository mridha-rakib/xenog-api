import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { PlanController } from "./plan.controller.js";
import { planValidation } from "./plan.validation.js";

const router = Router();
const controller = new PlanController();

router.use(authenticate);

router.post("/", validate(planValidation.createPlan), catchAsync(controller.createPlan));
router.get("/", validate(planValidation.listPlans), catchAsync(controller.listMyPlans));
router.get("/:id", validate(planValidation.planParams), catchAsync(controller.getPlan));
router.patch("/:id", validate(planValidation.updatePlan), catchAsync(controller.updatePlan));
router.delete("/:id", validate(planValidation.planParams), catchAsync(controller.deletePlan));

export const planRoutes = router;
