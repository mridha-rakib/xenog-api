import { z } from "zod";
import { creatorPayoutTypes } from "./creator-payout.interface.js";

export const creatorEarningValidation = {
  requestWithdrawal: z.object({
    body: z.object({
      payoutType: z.enum(creatorPayoutTypes, {
        required_error: "Payout type is required",
        invalid_type_error: "Payout type must be bank_transfer or mooment_credits",
      }),
    }),
  }),
};
