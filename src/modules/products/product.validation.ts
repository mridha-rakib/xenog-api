import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");

const optionalText = (label: string, maxLength: number) =>
  z
    .string({
      invalid_type_error: `${label} must be a string`,
    })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => value || null);

export const productValidation = {
  productParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  userProductsParams: z.object({
    params: z.object({
      userId: objectId,
    }),
  }),
  createProduct: z.object({
    body: z
      .object({
        name: z
          .string({
            required_error: "Product name is required",
            invalid_type_error: "Product name must be a string",
          })
          .trim()
          .min(1, "Product name is required")
          .max(160, "Product name cannot exceed 160 characters"),
        description: optionalText("Description", 5000),
        tag: optionalText("Tag", 80),
        priceUsd: z.coerce
          .number({
            required_error: "Price is required",
            invalid_type_error: "Price must be a number",
          })
          .positive("Price must be greater than zero")
          .max(1_000_000, "Price is too large"),
        discountPercent: z.coerce
          .number({
            invalid_type_error: "Discount must be a number",
          })
          .min(0, "Discount cannot be negative")
          .max(100, "Discount cannot exceed 100%")
          .default(0),
        totalProduct: z.coerce
          .number({
            required_error: "Total product is required",
            invalid_type_error: "Total product must be a number",
          })
          .int("Total product must be a whole number")
          .min(0, "Total product cannot be negative")
          .max(1_000_000, "Total product is too large"),
        imageKeys: z
          .array(z.string().trim().min(1).max(300), {
            invalid_type_error: "Images must be an array",
          })
          .max(10, "You cannot upload more than 10 product images")
          .default([]),
      })
      .strict(),
  }),
  updateProduct: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        name: z
          .string({
            required_error: "Product name is required",
            invalid_type_error: "Product name must be a string",
          })
          .trim()
          .min(1, "Product name is required")
          .max(160, "Product name cannot exceed 160 characters"),
        description: optionalText("Description", 5000),
        tag: optionalText("Tag", 80),
        priceUsd: z.coerce
          .number({
            required_error: "Price is required",
            invalid_type_error: "Price must be a number",
          })
          .positive("Price must be greater than zero")
          .max(1_000_000, "Price is too large"),
        discountPercent: z.coerce
          .number({
            invalid_type_error: "Discount must be a number",
          })
          .min(0, "Discount cannot be negative")
          .max(100, "Discount cannot exceed 100%")
          .default(0),
        totalProduct: z.coerce
          .number({
            required_error: "Total product is required",
            invalid_type_error: "Total product must be a number",
          })
          .int("Total product must be a whole number")
          .min(0, "Total product cannot be negative")
          .max(1_000_000, "Total product is too large"),
        imageKeys: z
          .array(z.string().trim().min(1).max(300), {
            invalid_type_error: "Images must be an array",
          })
          .max(10, "You cannot upload more than 10 product images")
          .default([]),
      })
      .strict(),
  }),
};
