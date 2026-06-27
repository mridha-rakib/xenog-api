import { z } from "zod";
import { legalDocumentTypes } from "./legal-document.interface.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Clause id must be a valid MongoDB ObjectId");

const legalDocumentType = z
  .string({
    required_error: "Document type is required",
    invalid_type_error: "Document type must be a string",
  })
  .trim()
  .refine(
    (value) => legalDocumentTypes.includes(value as (typeof legalDocumentTypes)[number]),
    "Document type must be either terms or privacy",
  );

const htmlToText = (value: string): string =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const legalDocumentClause = z
  .object({
    id: objectId.optional(),
    title: z
      .string({
        required_error: "Clause title is required",
        invalid_type_error: "Clause title must be a string",
      })
      .trim()
      .min(2, "Clause title must contain at least 2 characters")
      .max(160, "Clause title cannot exceed 160 characters"),
    body: z
      .string({
        required_error: "Clause body is required",
        invalid_type_error: "Clause body must be a string",
      })
      .trim()
      .min(1, "Clause body cannot be empty")
      .max(20000, "Clause body cannot exceed 20,000 characters")
      .refine((value) => htmlToText(value).length > 0, "Clause body must include readable text"),
    sortOrder: z
      .number({
        invalid_type_error: "Clause sort order must be a number",
      })
      .int("Clause sort order must be an integer")
      .min(0, "Clause sort order cannot be negative")
      .optional(),
  })
  .strict();

const pricingPercent = z.coerce
  .number({
    required_error: "Pricing value is required",
    invalid_type_error: "Pricing value must be a number",
  })
  .min(0, "Pricing value cannot be negative")
  .max(100, "Pricing value cannot exceed 100%");

export const settingsValidation = {
  getLegalDocument: z.object({
    params: z.object({
      type: legalDocumentType,
    }),
  }),
  updateLegalDocument: z.object({
    params: z.object({
      type: legalDocumentType,
    }),
    body: z
      .object({
        clauses: z
          .array(legalDocumentClause, {
            required_error: "Clauses are required",
            invalid_type_error: "Clauses must be an array",
          })
          .max(100, "A legal document cannot contain more than 100 clauses"),
        displayOnLandingPage: z
          .boolean({
            invalid_type_error: "Display on landing page must be true or false",
          })
          .optional(),
      })
      .strict(),
  }),
  updatePricingSettings: z.object({
    body: z
      .object({
        tax: pricingPercent,
        creditCardFee: pricingPercent,
        applePayoutFee: pricingPercent,
        platformFee: pricingPercent,
        productPercentage: pricingPercent,
        ticketPercentage: pricingPercent,
      })
      .strict(),
  }),
};
