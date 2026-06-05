import { z } from "zod";

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

const registerBody = z.object({
  name: z.string().trim().min(2).max(120),
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  accountType: z.enum(["personal", "business"]),
});

const verifyEmailBody = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{4}$/, "Verification code must be 4 digits"),
});

const refreshBody = z.object({
  refreshToken: z.string().trim().min(1, "Refresh token is required"),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8).max(128),
});

const nullableString = (max: number) => z.string().trim().max(max).nullable().optional();
const currentLocation = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).nullable().optional(),
  })
  .nullable()
  .optional();

const updateProfileBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    username: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores")
      .optional(),
    email: z.string().trim().email().optional(),
    contact: nullableString(40),
    accountType: z.enum(["personal", "business"]).optional(),
    avatarKey: nullableString(300),
    gender: nullableString(40),
    age: z.number().int().min(0).max(130).nullable().optional(),
    bio: nullableString(500),
    address: nullableString(240),
    businessDocumentKey: nullableString(300),
    currentLocationSharingEnabled: z.boolean().optional(),
    currentLocation,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const authValidation = {
  login: z.object({
    body: loginBody,
  }),
  register: z.object({
    body: registerBody,
  }),
  verifyEmail: z.object({
    body: verifyEmailBody,
  }),
  refresh: z.object({
    body: refreshBody,
  }),
  changePassword: z.object({
    body: changePasswordBody,
  }),
  resendVerification: z.object({
    body: z.object({
      email: z.string().trim().email(),
    }),
  }),
  updateProfile: z.object({
    body: updateProfileBody,
  }),
};
