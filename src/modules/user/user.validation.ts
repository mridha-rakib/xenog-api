import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");

export const userValidation = {
  create: z.object({
    body: z.object({
      name: z.string().min(2).max(120),
      email: z.string().email(),
      role: z.enum(["user", "admin"]).optional(),
    }),
  }),
  list: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
      search: z.string().max(120).optional(),
      role: z.enum(["user", "admin"]).optional(),
      isActive: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    }),
  }),
  getById: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  update: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        name: z.string().min(2).max(120).optional(),
        role: z.enum(["user", "admin"]).optional(),
        isActive: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "At least one field is required"),
  }),
  delete: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
};
