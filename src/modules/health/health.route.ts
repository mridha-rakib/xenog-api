import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { HealthController } from "./health.controller.js";

const router = Router();
const controller = new HealthController();

router.get("/", catchAsync(controller.check));

export const healthRoutes = router;
