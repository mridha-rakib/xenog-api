import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles, optionallyAuthenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { UserController } from "./user.controller.js";
import { userValidation } from "./user.validation.js";

const router = Router();
const controller = new UserController();

router.post("/", validate(userValidation.create), catchAsync(controller.create));
router.get("/", validate(userValidation.list), catchAsync(controller.list));
router.get(
  "/admin/management",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.adminList),
  catchAsync(controller.listForAdmin),
);
router.get(
  "/admin/management/:id",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.adminUser),
  catchAsync(controller.getForAdmin),
);
router.patch(
  "/admin/management/:id",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.adminUpdate),
  catchAsync(controller.updateForAdmin),
);
router.delete(
  "/admin/management/:id",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.adminUser),
  catchAsync(controller.deleteForAdmin),
);
router.get(
  "/suggestions",
  authenticate,
  validate(userValidation.suggestions),
  catchAsync(controller.listSuggestions),
);
router.get(
  "/friends",
  authenticate,
  validate(userValidation.friends),
  catchAsync(controller.listFriends),
);
router.get(
  "/:id/profile-stats",
  authenticate,
  validate(userValidation.profileResource),
  catchAsync(controller.getProfileStats),
);
router.get(
  "/:id/followers",
  authenticate,
  validate(userValidation.profileList),
  catchAsync(controller.listFollowers),
);
router.get(
  "/:id/following",
  authenticate,
  validate(userValidation.profileList),
  catchAsync(controller.listFollowing),
);
router.get(
  "/:id/reviews",
  authenticate,
  validate(userValidation.profileResource),
  catchAsync(controller.listReviews),
);
router.post(
  "/:id/follow",
  authenticate,
  validate(userValidation.follow),
  catchAsync(controller.follow),
);
router.delete(
  "/:id/follow",
  authenticate,
  validate(userValidation.follow),
  catchAsync(controller.unfollow),
);
router.post(
  "/:id/block",
  authenticate,
  validate(userValidation.block),
  catchAsync(controller.block),
);
router.delete(
  "/:id/block",
  authenticate,
  validate(userValidation.block),
  catchAsync(controller.unblock),
);
router.get("/:id", optionallyAuthenticate, validate(userValidation.getById), catchAsync(controller.getById));
router.patch(
  "/:id",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.update),
  catchAsync(controller.update),
);
router.delete(
  "/:id",
  authenticate,
  authorizeRoles("admin"),
  validate(userValidation.delete),
  catchAsync(controller.delete),
);

export const userRoutes = router;
