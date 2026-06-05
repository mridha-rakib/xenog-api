import { z } from "zod";
import { supportTicketStatuses } from "./support-ticket.interface.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Ticket id must be a valid MongoDB ObjectId");

const requiredText = (label: string, maxLength: number) =>
  z
    .string({
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a string`,
    })
    .trim()
    .min(1, `${label} is required`)
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`);

const status = z.enum(supportTicketStatuses, {
  invalid_type_error: "Status must be pending, solved, or dismissed",
});

export const supportTicketValidation = {
  createTicket: z.object({
    body: z
      .object({
        title: requiredText("Title", 160),
        description: requiredText("Description", 5000),
      })
      .strict(),
  }),
  listTickets: z.object({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(10),
      status: status.optional(),
      search: z
        .string()
        .trim()
        .max(120, "Search cannot exceed 120 characters")
        .optional()
        .transform((value) => (value ? value : undefined)),
    }),
  }),
  ticketParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  updateStatus: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        status,
      })
      .strict(),
  }),
  createMessage: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        body: requiredText("Message", 5000),
      })
      .strict(),
  }),
};
