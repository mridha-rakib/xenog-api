import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} must be a string` })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => value || null);

const location = z
  .object({
    address: z.string().trim().min(1, "Location address is required").max(240),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
  })
  .strict();

const friendIds = z.array(objectId).max(100).default([]).transform((ids) => [...new Set(ids)]);
const friendNames = z
  .array(z.string().trim().min(1).max(120))
  .max(100)
  .default([])
  .transform((names) => [...new Set(names)]);

export const planValidation = {
  createPlan: z.object({
    body: z
      .object({
        title: z.string().trim().min(1, "Plan name is required").max(120),
        scheduledAt: z.coerce.date({ invalid_type_error: "Plan date is required" }),
        timeLabel: optionalText("Time label", 40),
        eventTitle: optionalText("Event title", 200),
        location,
        friendIds,
        friendNames,
        notes: optionalText("Notes", 1000),
      })
      .strict(),
  }),
  listPlans: z.object({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    }),
  }),
  planParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  updatePlan: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        scheduledAt: z.coerce.date().optional(),
        timeLabel: optionalText("Time label", 40),
        eventTitle: optionalText("Event title", 200),
        location: location.optional(),
        friendIds: friendIds.optional(),
        friendNames: friendNames.optional(),
        notes: optionalText("Notes", 1000),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "At least one field is required"),
  }),
};
