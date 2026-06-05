import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const speakerIds = z
  .array(objectId, {
    invalid_type_error: "Speaker IDs must be an array",
  })
  .max(100, "You cannot assign more than 100 speakers")
  .transform((ids) => [...new Set(ids)]);

export const liveRoomValidation = {
  liveRoomParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  createLiveRoom: z.object({
    body: z
      .object({
        title: z.string().trim().min(1, "Room name is required").max(120, "Room name cannot exceed 120 characters"),
        allowAllParticipantsToSpeak: z.boolean().default(true),
        speakerIds: speakerIds.default([]),
      })
      .strict(),
  }),
  updatePermissions: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        allowAllParticipantsToSpeak: z.boolean().optional(),
        speakerIds: speakerIds.optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "At least one permission field is required"),
  }),
  listMessages: z.object({
    params: z.object({
      id: objectId,
    }),
    query: z.object({
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  createMessage: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        text: z.string().trim().min(1, "Message is required").max(1000, "Message cannot exceed 1000 characters"),
      })
      .strict(),
  }),
};
