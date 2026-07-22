import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const nullableString = (max: number) => z.string().trim().max(max).nullable().optional();
const currentLocation = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).nullable().optional(),
  })
  .nullable()
  .optional();

export const userValidation = {
  create: z.object({
    body: z.object({
      name: z.string().min(2).max(120),
      username: z
        .string()
        .trim()
        .min(3)
        .max(40)
        .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
        .optional(),
      email: z.string().email(),
      contact: nullableString(40),
      password: z.string().min(8).max(128).optional(),
      accountType: z.enum(["personal", "business"]).optional(),
      avatarKey: nullableString(300),
      gender: nullableString(40),
      age: z.number().int().min(0).max(130).nullable().optional(),
      bio: nullableString(500),
      address: nullableString(240),
      businessDocumentKey: nullableString(300),
      currentLocationSharingEnabled: z.boolean().optional(),
      currentLocation,
      notificationsEnabled: z.boolean().optional(),
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
  adminList: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
      search: z.string().trim().max(120).optional(),
      isActive: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
      accountType: z.enum(["personal", "business"]).optional(),
    }),
  }),
  adminUser: z.object({
    params: z.object({ id: objectId }),
  }),
  adminUpdate: z.object({
    params: z.object({ id: objectId }),
    body: z
      .object({
        isActive: z.boolean().optional(),
        emailVerified: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "At least one field is required"),
  }),
  suggestions: z.object({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  }),
  friends: z.object({
    query: z.object({
      search: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  blockedUsers: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  profileList: z.object({
    params: z.object({
      id: objectId,
    }),
    query: z.object({
      search: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      page: z.coerce.number().int().positive().optional(),
    }),
  }),
  profileReviews: z.object({
    params: z.object({
      id: objectId,
    }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      page: z.coerce.number().int().positive().optional(),
    }),
  }),
  profileResource: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  getById: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  follow: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  block: z.object({
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
        email: z.string().email().optional(),
        contact: nullableString(40),
        username: z
          .string()
          .trim()
          .min(3)
          .max(40)
          .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
          .optional(),
        accountType: z.enum(["personal", "business"]).optional(),
        avatarKey: nullableString(300),
        gender: nullableString(40),
        age: z.number().int().min(0).max(130).nullable().optional(),
        bio: nullableString(500),
        address: nullableString(240),
        businessDocumentKey: nullableString(300),
        currentLocationSharingEnabled: z.boolean().optional(),
        currentLocation,
        notificationsEnabled: z.boolean().optional(),
        role: z.enum(["user", "admin"]).optional(),
        isActive: z.boolean().optional(),
        emailVerified: z.boolean().optional(),
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
