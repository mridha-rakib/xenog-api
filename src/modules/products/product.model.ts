import { Schema, model } from "mongoose";
import type { IProduct } from "./product.interface.js";

const productSchema = new Schema<IProduct>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },
    tag: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    priceUsd: {
      type: Number,
      required: true,
      min: 0.01,
    },
    discountPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 0,
    },
    totalProduct: {
      type: Number,
      required: true,
      min: 0,
    },
    imageKeys: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

productSchema.index({ name: "text", description: "text", tag: "text" });

export const ProductModel = model<IProduct>("Product", productSchema);
