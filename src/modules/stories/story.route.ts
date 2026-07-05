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
router.get("/discover", catchAsync(controller.listDiscoverStories));
router.get("/friends", catchAsync(controller.listFriendStories));
router.get("/user/:userId", validate(storyValidation.userId), catchAsync(controller.listUserStories));
router.get("/:id", validate(storyValidation.storyId), catchAsync(controller.getStoryDetails));
router.post("/:id/view", validate(storyValidation.storyId), catchAsync(controller.recordView));
router.post("/:id/reaction", validate(storyValidation.storyId), catchAsync(controller.toggleReaction));
router.get("/:id/comments", validate(storyValidation.storyId), catchAsync(controller.listComments));
router.post("/:id/comments", validate(storyValidation.createComment), catchAsync(controller.createComment));
router.post("/:id/share", validate(storyValidation.shareStory), catchAsync(controller.shareToFeed));
router.delete("/:id", validate(storyValidation.storyId), catchAsync(controller.deleteStory));

export const storyRoutes = router;
