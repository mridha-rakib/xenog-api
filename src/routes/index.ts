import { Router } from "express";
import { healthRoutes } from "../modules/health/health.route.js";
import { storageRoutes } from "../modules/storage/storage.route.js";
import { userRoutes } from "../modules/user/user.route.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/storage", storageRoutes);
router.use("/users", userRoutes);

export const appRoutes = router;
