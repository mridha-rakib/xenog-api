import { z } from "zod";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const cartQuantity = z.coerce
  .number({
    required_error: "Quantity is required",
    invalid_type_error: "Quantity must be a number",
  })
  .int("Quantity must be a whole number")
  .min(1, "Quantity must be at least 1")
  .max(1_000_000, "Quantity is too large");

export const cartValidation = {
  addItem: z.object({
    body: z
      .object({
        productId: objectId,
        quantity: cartQuantity.default(1),
      })
      .strict(),
  }),
  updateItem: z.object({
    params: z.object({
      productId: objectId,
    }),
    body: z
      .object({
        quantity: cartQuantity,
      })
      .strict(),
  }),
  productParams: z.object({
    params: z.object({
      productId: objectId,
    }),
  }),
};
