import { z } from "zod";
import { eventAgeRestrictions, eventCategories, eventPrivacyOptions, eventTicketTypes } from "./event.interface.js";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const ticketId = z.string().trim().min(1, "Ticket ID is required").max(80, "Ticket ID cannot exceed 80 characters");

const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} must be a string` })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => value || null);

const queryNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }

      return Number(value);
    },
    schema.optional(),
  );

const eventCategory = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.enum(eventCategories, {
    invalid_type_error: "Category must be one of the predefined event categories",
    required_error: "Category is required",
  }),
);

const optionalEventCategory = eventCategory.optional().nullable().transform((value) => value ?? null);

const normalizedNumber = z.number().min(0).max(1);

const bannerImageDisplay = z
  .object({
    crop: z
      .object({
        x: normalizedNumber,
        y: normalizedNumber,
        width: normalizedNumber.refine((value) => value > 0, "Crop width is required"),
        height: normalizedNumber.refine((value) => value > 0, "Crop height is required"),
      })
      .strict()
      .refine((value) => value.x + value.width <= 1.001 && value.y + value.height <= 1.001, {
        message: "Crop area must stay inside the image",
      })
      .optional()
      .nullable(),
    imageWidth: z.number().int().positive().optional().nullable(),
    imageHeight: z.number().int().positive().optional().nullable(),
  })
  .strict()
  .optional()
  .nullable()
  .transform((value) => value ?? null);

const eventLocation = z
  .object({
    searchLabel: optionalText("Location", 240),
    venue: optionalText("Venue", 160),
    address: optionalText("Address", 240),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
  })
  .strict();

const eventTicketShape = {
  id: ticketId.optional(),
  name: z.string().trim().min(1, "Ticket name is required").max(120),
  description: optionalText("Ticket description", 1000),
  salesEndAt: z.coerce.date().optional().nullable().transform((value) => value ?? null),
  type: z.enum(eventTicketTypes).default("free"),
  price: z.coerce.number().min(0).max(1_000_000).default(0),
  capacity: z.coerce.number().int().min(0).max(1_000_000),
};

const eventTicket = z
  .object(eventTicketShape)
  .strict()
  .transform((ticket) => ({
    ...ticket,
    price: ticket.type === "free" ? 0 : ticket.price,
  }));

const updateEventTicket = z
  .object({
    name: eventTicketShape.name.optional(),
    description: eventTicketShape.description,
    salesEndAt: eventTicketShape.salesEndAt,
    type: z.enum(eventTicketTypes).optional(),
    price: z.coerce.number().min(0).max(1_000_000).optional(),
    capacity: eventTicketShape.capacity.optional(),
  })
  .strict()
  .refine((ticket) => Object.values(ticket).some((value) => value !== undefined), {
    message: "At least one ticket field is required",
  })
  .transform((ticket) => ({
    ...ticket,
    ...(ticket.type === "free" ? { price: 0 } : {}),
  }));

const draftBody = z
  .object({
    name: optionalText("Event name", 160),
    description: optionalText("Description", 5000),
    bannerImageKey: optionalText("Banner image", 300),
    bannerOriginalImageKey: optionalText("Original banner image", 300),
    bannerImageDisplay,
    ageRestriction: z.enum(eventAgeRestrictions).optional().nullable(),
    category: optionalEventCategory,
    scheduledAt: z.coerce.date().optional().nullable().transform((value) => value ?? null),
    location: eventLocation.optional().nullable(),
    tickets: z.array(eventTicket).max(100).optional(),
    privacy: z.enum(eventPrivacyOptions).default("public").optional(),
  })
  .strict();

const publishBody = draftBody.extend({
  name: z.string().trim().min(1, "Event name is required").max(160),
  ageRestriction: z.enum(eventAgeRestrictions),
  category: eventCategory,
  scheduledAt: z.coerce.date(),
  location: eventLocation.refine((value) => Boolean(value.venue || value.address || value.searchLabel), {
    message: "Location is required",
  }),
  tickets: z.array(eventTicket).max(100).default([]),
  privacy: z.enum(eventPrivacyOptions).default("public"),
});

const mapQuery = z
  .object({
    latitude: queryNumber(z.number().min(-90).max(90)),
    longitude: queryNumber(z.number().min(-180).max(180)),
    radiusKm: queryNumber(z.number().min(1).max(250)),
    limit: queryNumber(z.number().int().min(1).max(200)),
  })
  .strict()
  .refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
    message: "Latitude and longitude must be provided together",
    path: ["longitude"],
  });

export const eventValidation = {
  eventParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  saveDraft: z.object({
    body: draftBody,
  }),
  updateDraft: z.object({
    params: z.object({
      id: objectId,
    }),
    body: draftBody,
  }),
  publish: z.object({
    body: publishBody,
  }),
  publishDraft: z.object({
    params: z.object({
      id: objectId,
    }),
    body: publishBody,
  }),
  createDraftTicket: z.object({
    params: z.object({
      id: objectId,
    }),
    body: eventTicket,
  }),
  updateDraftTicket: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
    body: updateEventTicket,
  }),
  deleteDraftTicket: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
  }),
  mapEvents: z.object({
    query: mapQuery,
  }),
};
