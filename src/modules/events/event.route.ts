import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles, requireBusinessAccount } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { EventController } from "./event.controller.js";
import { eventValidation } from "./event.validation.js";

const router = Router();
const controller = new EventController();

router.use(authenticate);

// Block all write operations for non-business accounts.
// Exempt: GET (read-only) and the attendee reward-claim action.
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.method === "POST" && /\/rewards\/[^/]+\/claim$/.test(req.path)) return next();
  if (req.method === "POST" && /\/join-requests$/.test(req.path)) return next();
  requireBusinessAccount(req, res, next);
});

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
router.get("/feed", catchAsync(controller.listFeedEvents));
router.get("/mine/profile", catchAsync(controller.listMyProfileEvents));
router.get("/mine/post-tag", catchAsync(controller.listMyPostTagEvents));
router.get("/mine/drafts", catchAsync(controller.listMyDraftEvents));
router.get("/mine", catchAsync(controller.listMyEvents));
router.get("/:id/ticket-access", validate(eventValidation.eventParams), catchAsync(controller.getTicketAccess));
router.get("/now", validate(eventValidation.nowModeEvents), catchAsync(controller.listNowModeEvents));
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
router.post("/:id/save", validate(eventValidation.eventParams), catchAsync(controller.saveEvent));
router.post("/:id/start", validate(eventValidation.eventParams), catchAsync(controller.startEvent));
router.post("/:id/complete", validate(eventValidation.eventParams), catchAsync(controller.completeEvent));
router.post("/:id/cancel", validate(eventValidation.eventParams), catchAsync(controller.cancelEvent));
router.get("/:id/members", validate(eventValidation.listEventMembers), catchAsync(controller.listEventMembers));
router.post("/:id/members", validate(eventValidation.addEventMember), catchAsync(controller.addEventMember));
router.delete("/:id/members/:userId", validate(eventValidation.removeEventMember), catchAsync(controller.removeEventMember));
router.get("/admin/users/:userId/events", authorizeRoles("admin"), validate(eventValidation.adminUserEvents), catchAsync(controller.listUserEventsForAdmin));
router.post("/:id/join-requests", validate(eventValidation.submitJoinRequest), catchAsync(controller.submitJoinRequest));
router.get("/:id/join-requests", validate(eventValidation.listJoinRequests), catchAsync(controller.listJoinRequests));
router.post("/:id/join-requests/:requestUserId/accept", validate(eventValidation.joinRequestAction), catchAsync(controller.acceptJoinRequest));
router.post("/:id/join-requests/:requestUserId/decline", validate(eventValidation.joinRequestAction), catchAsync(controller.declineJoinRequest));
router.patch("/:id", validate(eventValidation.updateEvent), catchAsync(controller.updateEvent));
router.delete("/:id", validate(eventValidation.deleteEvent), catchAsync(controller.deleteEvent));
router.get("/:id", validate(eventValidation.eventParams), catchAsync(controller.getEventById));

export const eventRoutes = router;
