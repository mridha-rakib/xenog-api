import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { UserController } from "./user.controller.js";
import { userValidation } from "./user.validation.js";

const router = Router();
const controller = new UserController();

router.post("/", validate(userValidation.create), catchAsync(controller.create));
router.get("/", validate(userValidation.list), catchAsync(controller.list));
router.get("/:id", validate(userValidation.getById), catchAsync(controller.getById));
router.patch("/:id", validate(userValidation.update), catchAsync(controller.update));
router.delete("/:id", validate(userValidation.delete), catchAsync(controller.delete));

export const userRoutes = router;
