import { z } from "zod";
import { payoutPreferences, withdrawalMethods } from "../user/user.interface.js";

export const payoutSettingsValidation = {
  updatePayoutSettings: z.object({
    body: z
      .object({
        payoutPreference: z
          .enum(payoutPreferences, {
            invalid_type_error: "payoutPreference must be manual, weekly, or monthly",
          })
          .optional(),
        withdrawalMethod: z
          .enum(withdrawalMethods, {
            invalid_type_error: "withdrawalMethod must be bank_transfer or instant_debit_card",
          })
          .optional(),
      })
      .refine((body) => body.payoutPreference !== undefined || body.withdrawalMethod !== undefined, {
        message: "At least one of payoutPreference or withdrawalMethod must be provided",
      }),
  }),
};
