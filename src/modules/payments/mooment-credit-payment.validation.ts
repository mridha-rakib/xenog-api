import { z } from "zod";
import { moomentCreditPaymentMethods } from "./mooment-credit-payment.interface.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");

export const moomentCreditPaymentValidation = {
  getCheckoutQuote: z.object({
    params: z.object({
      packageId: objectId,
    }),
  }),
  purchaseCredits: z.object({
    body: z.object({
      packageId: objectId,
      paymentMethod: z.enum(moomentCreditPaymentMethods, {
        required_error: "Payment method is required",
        invalid_type_error: "Payment method must be stripe, card, or apple",
      }),
      acceptedTerms: z.boolean().optional(),
    }),
  }),
};
