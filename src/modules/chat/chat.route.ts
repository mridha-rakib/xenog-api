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

// Static route registered before the dynamic /dms/:friendId/... routes
// below, matching this file's and user.route.ts's existing convention
// (see GET /users/me/blocked-users vs GET /users/:id) so it can never be
// swallowed by dynamic param matching.
router.get(
  "/dms/message-blocked",
  validate(chatValidation.listMessageBlockedUsers),
  catchAsync(controller.listMessageBlockedUsers),
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

router.get(
  "/dms/:friendId/relationship",
  validate(chatValidation.getDirectMessageRelationship),
  catchAsync(controller.getDirectMessageRelationship),
);

router.post(
  "/dms/:friendId/message-block",
  validate(chatValidation.messageBlock),
  catchAsync(controller.blockMessages),
);

router.delete(
  "/dms/:friendId/message-block",
  validate(chatValidation.messageBlock),
  catchAsync(controller.unblockMessages),
);

router.delete(
  "/dms/:friendId",
  validate(chatValidation.deleteConversation),
  catchAsync(controller.deleteConversation),
);

export const chatRoutes = router;
