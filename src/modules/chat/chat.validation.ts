import { z } from "zod";
import { chatMessageTypes } from "./chat.interface.js";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid user id");

const fileAttachmentSchema = z.object({
  type: z.enum(["image", "video", "audio"]),
  key: z.string().trim().min(1).max(300),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive().max(250 * 1024 * 1024),
  fileName: z.string().trim().max(180).optional().nullable(),
  width: z.number().int().positive().max(10000).optional().nullable(),
  height: z.number().int().positive().max(10000).optional().nullable(),
  durationSeconds: z.number().nonnegative().max(24 * 60 * 60).optional().nullable(),
}).strict();

export const chatMessageAttachmentSchema = z.discriminatedUnion("type", [
  fileAttachmentSchema.extend({ type: z.literal("image") }),
  fileAttachmentSchema.extend({ type: z.literal("video") }),
  fileAttachmentSchema.extend({ type: z.literal("audio") }),
  z.object({
    type: z.literal("location"),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    label: z.string().trim().max(120).optional().nullable(),
    address: z.string().trim().max(300).optional().nullable(),
  }).strict(),
  z.object({
    type: z.literal("event"),
    eventId: objectId,
  }).strict(),
]);

export const chatMessageBodySchema = z
  .object({
    type: z.enum(chatMessageTypes).optional(),
    text: z.string().trim().max(2000).optional(),
    attachment: chatMessageAttachmentSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const type = value.type ?? value.attachment?.type ?? "text";
    const text = value.text?.trim() ?? "";

    if (type === "text" && !text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message text is required",
        path: ["text"],
      });
    }

    if (type !== "text" && !value.attachment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Attachment is required",
        path: ["attachment"],
      });
    }

    if (value.attachment && value.attachment.type !== type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message type must match attachment type",
        path: ["type"],
      });
    }
  });

export const chatValidation = {
  listDirectMessages: z.object({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      search: z.string().trim().max(120).optional(),
    }),
  }),
  listDirectMessageHistory: z.object({
    params: z.object({
      friendId: objectId,
    }),
    query: z.object({
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  deleteConversation: z.object({
    params: z.object({ friendId: objectId }),
  }),
  createDirectMessage: z.object({
    params: z.object({
      friendId: objectId,
    }),
    body: chatMessageBodySchema,
  }),
};
