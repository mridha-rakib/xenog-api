import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { LiveRoomController } from "./live-room.controller.js";
import { liveRoomValidation } from "./live-room.validation.js";

const router = Router();
const controller = new LiveRoomController();

router.use(authenticate);

router.post("/", validate(liveRoomValidation.createLiveRoom), catchAsync(controller.createLiveRoom));
router.get("/:id", validate(liveRoomValidation.liveRoomParams), catchAsync(controller.getLiveRoom));
router.post("/:id/join", validate(liveRoomValidation.liveRoomParams), catchAsync(controller.joinLiveRoom));
router.post("/:id/leave", validate(liveRoomValidation.liveRoomParams), catchAsync(controller.leaveLiveRoom));
router.patch("/:id/permissions", validate(liveRoomValidation.updatePermissions), catchAsync(controller.updatePermissions));
router.get("/:id/messages", validate(liveRoomValidation.listMessages), catchAsync(controller.listMessages));
router.post("/:id/messages", validate(liveRoomValidation.createMessage), catchAsync(controller.createMessage));

export const liveRoomRoutes = router;
