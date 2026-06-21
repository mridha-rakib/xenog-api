import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { GroupController } from "./group.controller.js";
import { groupValidation } from "./group.validation.js";

const router = Router();
const controller = new GroupController();

router.use(authenticate);

router.post("/", validate(groupValidation.createGroup), catchAsync(controller.createGroup));
router.get("/", validate(groupValidation.listGroups), catchAsync(controller.listGroups));
router.post("/:groupId/messages", validate(groupValidation.createGroupMessage), catchAsync(controller.createGroupMessage));
router.get("/:groupId/messages", validate(groupValidation.listGroupMessages), catchAsync(controller.listGroupMessages));

export const groupRoutes = router;
