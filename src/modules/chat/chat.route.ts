import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { ChatController } from "./chat.controller.js";
import { chatValidation } from "./chat.validation.js";

const router = Router();
const controller = new ChatController();

router.use(authenticate);

router.get(
  "/dms",
  validate(chatValidation.listDirectMessages),
  catchAsync(controller.listDirectMessages),
);

router.get(
  "/dms/:friendId/messages",
  validate(chatValidation.listDirectMessageHistory),
  catchAsync(controller.listDirectMessageHistory),
);

router.post(
  "/dms/:friendId/messages",
  validate(chatValidation.createDirectMessage),
  catchAsync(controller.createDirectMessage),
);

export const chatRoutes = router;
