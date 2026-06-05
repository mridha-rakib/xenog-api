import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { StoryController } from "./story.controller.js";
import { storyValidation } from "./story.validation.js";

const router = Router();
const controller = new StoryController();

router.use(authenticate);

router.post(
  "/",
  validate(storyValidation.createStory),
  catchAsync(controller.createStory),
);

router.get("/", catchAsync(controller.listFeedStories));
router.get("/mine", catchAsync(controller.listMyStories));

export const storyRoutes = router;
