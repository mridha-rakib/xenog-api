import { z } from "zod";
import { checkoutPaymentMethods } from "./checkout-payment.interface.js";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const ticketId = z.string().trim().min(1, "Ticket ID is required").max(80, "Ticket ID cannot exceed 80 characters");
const paymentMethod = z.enum(checkoutPaymentMethods);
const quantity = z.coerce.number().int().min(1).max(100);
const ticketStatFilter = z.enum(["going", "attended", "canceled", "noShow"]);

const acceptedTerms = z.literal(true, {
  invalid_type_error: "Terms must be accepted",
  required_error: "Terms must be accepted",
});

const ticketIntent = z
  .object({
    kind: z.literal("ticket"),
    paymentMethod,
    eventId: objectId,
    ticketId,
    quantity,
    anonymous: z.boolean().optional().default(false),
    acceptedTerms,
  })
  .strict();

const productIntent = z
  .object({
    kind: z.literal("product"),
    paymentMethod,
    items: z
      .array(
        z
          .object({
            productId: objectId,
            quantity,
          })
          .strict(),
      )
      .min(1)
      .max(25),
    acceptedTerms,
  })
  .strict();

const customIntent = z
  .object({
    kind: z.literal("custom"),
    paymentMethod,
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(180),
            amount: z.coerce.number().positive().max(1_000_000),
            quantity,
          })
          .strict(),
      )
      .min(1)
      .max(25),
    acceptedTerms,
  })
  .strict();

export const checkoutPaymentValidation = {
  createIntent: z.object({
    body: z.discriminatedUnion("kind", [ticketIntent, productIntent, customIntent]),
  }),
  orderParams: z.object({
    params: z.object({
      orderId: objectId,
    }),
  }),
  eventParams: z.object({
    params: z.object({
      eventId: objectId,
    }),
  }),
  shareTicket: z.object({
    body: z
      .object({
        eventId: objectId,
        ticketId,
        orderId: objectId,
        ticketIndex: z.coerce.number().int().min(1).max(100),
        friendId: objectId,
      })
      .strict(),
  }),
  scanTicket: z.object({
    body: z
      .object({
        checkInCode: z
          .string()
          .trim()
          .toUpperCase()
          .max(64, "Invalid ticket"),
        eventId: objectId.optional(),
      })
      .strict(),
  }),
  shareParams: z.object({
    params: z.object({
      shareId: objectId,
    }),
  }),
  idParam: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  ticketStatItems: z.object({
    params: z.object({
      id: objectId,
    }),
    query: z.object({
      status: ticketStatFilter.optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
};
