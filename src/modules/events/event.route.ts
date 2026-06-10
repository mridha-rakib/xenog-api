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
router.post("/drafts/:id/tickets", validate(eventValidation.createDraftTicket), catchAsync(controller.createDraftTicket));
router.patch(
  "/drafts/:id/tickets/:ticketId",
  validate(eventValidation.updateDraftTicket),
  catchAsync(controller.updateDraftTicket),
);
router.delete(
  "/drafts/:id/tickets/:ticketId",
  validate(eventValidation.deleteDraftTicket),
  catchAsync(controller.deleteDraftTicket),
);
router.post("/publish", validate(eventValidation.publish), catchAsync(controller.publish));
router.post("/:id/publish", validate(eventValidation.publishDraft), catchAsync(controller.publishDraft));
router.get("/mine/profile", catchAsync(controller.listMyProfileEvents));
router.get("/mine", catchAsync(controller.listMyEvents));
router.get("/map", validate(eventValidation.mapEvents), catchAsync(controller.listMapEvents));
router.get("/:id", validate(eventValidation.eventParams), catchAsync(controller.getEventById));

export const eventRoutes = router;
