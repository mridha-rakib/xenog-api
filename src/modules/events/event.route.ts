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
router.post("/drafts/:id/rewards", validate(eventValidation.createDraftReward), catchAsync(controller.createDraftReward));
router.patch(
  "/drafts/:id/rewards/:rewardId",
  validate(eventValidation.updateDraftReward),
  catchAsync(controller.updateDraftReward),
);
router.delete(
  "/drafts/:id/rewards/:rewardId",
  validate(eventValidation.deleteDraftReward),
  catchAsync(controller.deleteDraftReward),
);
router.post("/publish", validate(eventValidation.publish), catchAsync(controller.publish));
router.post("/:id/publish", validate(eventValidation.publishDraft), catchAsync(controller.publishDraft));
router.get("/mine/profile", catchAsync(controller.listMyProfileEvents));
router.get("/mine", catchAsync(controller.listMyEvents));
router.get("/map", validate(eventValidation.mapEvents), catchAsync(controller.listMapEvents));
router.get("/profile/:userId", validate(eventValidation.profileEvents), catchAsync(controller.listProfileEvents));
router.get("/:id/tickets/:ticketId", validate(eventValidation.eventTicketParams), catchAsync(controller.getEventTicket));
router.post("/:id/tickets", validate(eventValidation.createEventTicket), catchAsync(controller.createEventTicket));
router.patch(
  "/:id/tickets/:ticketId",
  validate(eventValidation.updateEventTicket),
  catchAsync(controller.updateEventTicket),
);
router.delete("/:id/tickets/:ticketId", validate(eventValidation.eventTicketParams), catchAsync(controller.deleteEventTicket));
router.get("/:id/rewards/claims", validate(eventValidation.getEventRewardClaims), catchAsync(controller.getMyEventRewardClaims));
router.post("/:id/rewards", validate(eventValidation.createEventReward), catchAsync(controller.createEventReward));
router.post("/:id/rewards/:rewardId/claim", validate(eventValidation.claimReward), catchAsync(controller.claimReward));
router.patch(
  "/:id/rewards/:rewardId",
  validate(eventValidation.updateEventReward),
  catchAsync(controller.updateEventReward),
);
router.delete("/:id/rewards/:rewardId", validate(eventValidation.eventRewardParams), catchAsync(controller.deleteEventReward));
router.patch("/:id", validate(eventValidation.updateEvent), catchAsync(controller.updateEvent));
router.delete("/:id", validate(eventValidation.deleteEvent), catchAsync(controller.deleteEvent));
router.get("/:id", validate(eventValidation.eventParams), catchAsync(controller.getEventById));

export const eventRoutes = router;
