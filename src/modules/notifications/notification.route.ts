import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { NotificationController } from "./notification.controller.js";

const router = Router();
const controller = new NotificationController();

router.use(authenticate);

router.get("/", catchAsync(controller.list));
router.get("/unread-count", catchAsync(controller.countUnread));
router.patch("/read-all", catchAsync(controller.markAllRead));

export const notificationRoutes = router;
