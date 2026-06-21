import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const groupValidation = {
  createGroup: z.object({
    body: z
      .object({
        name: z.string().trim().min(1, "Group name is required").max(100),
        memberIds: z.array(objectId).min(1, "At least one member is required").max(50),
        avatarKey: z.string().trim().max(500).optional().nullable(),
      })
      .strict(),
  }),
  listGroups: z.object({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  createGroupMessage: z.object({
    params: z.object({ groupId: objectId }),
    body: z
      .object({
        text: z.string().trim().min(1, "Message text is required").max(2000),
      })
      .strict(),
  }),
  listGroupMessages: z.object({
    params: z.object({ groupId: objectId }),
    query: z.object({
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
};
