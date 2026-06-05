import { z } from "zod";

const redirectUrl = z
  .string({
    invalid_type_error: "Redirect URL must be a string",
  })
  .trim()
  .url("Redirect URL must be a valid URL")
  .max(2048, "Redirect URL is too long");

export const stripeConnectValidation = {
  createOnboardingLink: z.object({
    body: z
      .object({
        returnUrl: redirectUrl.optional(),
        refreshUrl: redirectUrl.optional(),
      })
      .strict(),
  }),
};
