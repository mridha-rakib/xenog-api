import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { MomentController } from "./moment.controller.js";
import { momentValidation } from "./moment.validation.js";

const router = Router();
const controller = new MomentController();

router.use(authenticate);

router.post(
  "/",
  validate(momentValidation.createMoment),
  catchAsync(controller.createMoment),
);

router.get(
  "/profile/:userId/timeline",
  validate(momentValidation.profileTimeline),
  catchAsync(controller.getProfileTimeline),
);
router.post(
  "/:id/share",
  validate(momentValidation.momentIdParam),
  catchAsync(controller.shareMoment),
);
router.post(
  "/:id/reaction",
  validate(momentValidation.momentIdParam),
  catchAsync(controller.toggleMomentReaction),
);
router.delete(
  "/:id",
  validate(momentValidation.momentIdParam),
  catchAsync(controller.deleteMoment),
);
router.get(
  "/:id/comments",
  validate(momentValidation.momentIdParam),
  catchAsync(controller.listMomentComments),
);
router.post(
  "/:id/comments",
  validate(momentValidation.createComment),
  catchAsync(controller.createMomentComment),
);
router.get("/", catchAsync(controller.listFeedMoments));
router.get("/mine", catchAsync(controller.listMyMoments));

export const momentRoutes = router;
