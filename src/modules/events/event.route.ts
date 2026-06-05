import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { EventController } from "./event.controller.js";
import { eventValidation } from "./event.validation.js";

const router = Router();
const controller = new EventController();

router.use(authenticate);

router.post("/drafts", validate(eventValidation.saveDraft), catchAsync(controller.saveDraft));
router.patch("/drafts/:id", validate(eventValidation.updateDraft), catchAsync(controller.updateDraft));
router.post("/publish", validate(eventValidation.publish), catchAsync(controller.publish));
router.post("/:id/publish", validate(eventValidation.publishDraft), catchAsync(controller.publishDraft));
router.get("/mine", catchAsync(controller.listMyEvents));
router.get("/map", validate(eventValidation.mapEvents), catchAsync(controller.listMapEvents));

export const eventRoutes = router;
