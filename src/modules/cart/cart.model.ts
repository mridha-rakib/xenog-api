import { Schema, model } from "mongoose";
import type { ICartItem } from "./cart.interface.js";

const cartItemSchema = new Schema<ICartItem>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 1_000_000,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

cartItemSchema.index({ userId: 1, productId: 1 }, { unique: true });
cartItemSchema.index({ userId: 1, updatedAt: -1 });

export const CartItemModel = model<ICartItem>("CartItem", cartItemSchema);
