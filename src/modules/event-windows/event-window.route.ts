import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { EventWindowController } from "./event-window.controller.js";
import { eventWindowValidation } from "./event-window.validation.js";

const router = Router();
const controller = new EventWindowController();

router.use(authenticate);

router.post(
  "/:eventId/windows",
  validate(eventWindowValidation.createWindow),
  catchAsync(controller.createWindow),
);
router.get(
  "/:eventId/windows",
  validate(eventWindowValidation.eventWindowParams),
  catchAsync(controller.listWindows),
);
router.patch(
  "/:eventId/windows/:windowId",
  validate(eventWindowValidation.updateWindow),
  catchAsync(controller.updateWindow),
);
router.post(
  "/:eventId/windows/:windowId/cancel",
  validate(eventWindowValidation.eventWindowPostParams),
  catchAsync(controller.cancelWindow),
);
router.post(
  "/:eventId/windows/:windowId/posts",
  validate(eventWindowValidation.createPost),
  catchAsync(controller.createPost),
);
router.get(
  "/:eventId/windows/:windowId/posts/:postId/media/:mediaIndex",
  validate(eventWindowValidation.eventWindowPostMediaParams),
  catchAsync(controller.streamMedia),
);
router.get(
  "/:eventId/windows/:windowId/posts",
  validate(eventWindowValidation.listPosts),
  catchAsync(controller.listPosts),
);

export const eventWindowRoutes = router;
