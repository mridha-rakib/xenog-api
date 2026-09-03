import { z } from "zod";

/**
 * Approved signup password complexity rules. Keep this list in sync with the
 * mobile client copy in `app/lib/passwordValidation.ts` (same rules, same order).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULE_MESSAGES = {
  minLength: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  lowercase: "Password must include at least one lowercase letter.",
  uppercase: "Password must include at least one uppercase letter.",
  number: "Password must include at least one number.",
  special: "Password must include at least one special character.",
} as const;

const hasLowercase = (value: string) => /[a-z]/.test(value);
const hasUppercase = (value: string) => /[A-Z]/.test(value);
const hasNumber = (value: string) => /[0-9]/.test(value);
const hasSpecialCharacter = (value: string) => /[^A-Za-z0-9]/.test(value);

/**
 * String schema that enforces the approved password complexity rules. One Zod
 * issue is added per unmet rule so the existing `formatZodError` output shape
 * (`{ issues, fields }`) is preserved.
 */
export const passwordSchema = z
  .string()
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((value, ctx) => {
    if (value.length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_RULE_MESSAGES.minLength });
    }

    if (!hasLowercase(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_RULE_MESSAGES.lowercase });
    }

    if (!hasUppercase(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_RULE_MESSAGES.uppercase });
    }

    if (!hasNumber(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_RULE_MESSAGES.number });
    }

    if (!hasSpecialCharacter(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_RULE_MESSAGES.special });
    }
  });
