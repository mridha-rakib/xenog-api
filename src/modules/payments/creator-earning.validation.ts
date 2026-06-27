import { z } from "zod";
import { creatorPayoutTypes } from "./creator-payout.interface.js";

export const creatorEarningValidation = {
  requestWithdrawal: z.object({
    body: z.object({
      payoutType: z.enum(creatorPayoutTypes).optional(),
      amount: z
        .number({ invalid_type_error: "amount must be a number" })
        .positive({ message: "amount must be greater than zero" })
        .optional(),
    }),
  }),
  getEventEarnings: z.object({
    params: z.object({
      eventId: z.string().min(1, "Event ID is required"),
    }),
  }),
};
