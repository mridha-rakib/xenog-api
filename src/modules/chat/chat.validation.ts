import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid user id");

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
    body: z
      .object({
        text: z.string().trim().min(1, "Message text is required").max(2000),
      })
      .strict(),
  }),
};
