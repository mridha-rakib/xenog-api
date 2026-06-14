import type { Types } from "mongoose";
import type { ProductResponse } from "../products/product.interface.js";

export interface ICartItem {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  productId: Types.ObjectId;
  quantity: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddCartItemDto {
  productId: string;
  quantity?: number;
}

export interface UpdateCartItemDto {
  quantity: number;
}

export interface CartItemResponse {
  id: string;
  productId: string;
  quantity: number;
  unitPriceUsd: number;
  lineTotalUsd: number;
  stockQuantity: number;
  product: ProductResponse;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartResponse {
  items: CartItemResponse[];
  totalQuantity: number;
  subtotalUsd: number;
}
