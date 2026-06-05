import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate, authorizeRoles } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { SupportTicketController } from "./support-ticket.controller.js";
import { supportTicketValidation } from "./support-ticket.validation.js";

const router = Router();
const controller = new SupportTicketController();

router.use(authenticate);

router.post(
  "/tickets",
  validate(supportTicketValidation.createTicket),
  catchAsync(controller.createTicket),
);

router.use(authorizeRoles("admin"));

router.get(
  "/admin/tickets",
  validate(supportTicketValidation.listTickets),
  catchAsync(controller.listTickets),
);

router.get(
  "/admin/tickets/:id",
  validate(supportTicketValidation.ticketParams),
  catchAsync(controller.getTicket),
);

router.patch(
  "/admin/tickets/:id/status",
  validate(supportTicketValidation.updateStatus),
  catchAsync(controller.updateStatus),
);

router.post(
  "/admin/tickets/:id/messages",
  validate(supportTicketValidation.createMessage),
  catchAsync(controller.createMessage),
);

export const supportTicketRoutes = router;
