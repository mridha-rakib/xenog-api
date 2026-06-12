import type { Types } from "mongoose";

export const productStatuses = ["published"] as const;
export type ProductStatus = (typeof productStatuses)[number];

export interface IProduct {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status?: ProductStatus;
  name: string;
  description?: string | null;
  tag?: string | null;
  priceUsd: number;
  discountPercent: number;
  totalProduct: number;
  imageKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductDto {
  status?: ProductStatus;
  name: string;
  description?: string | null;
  tag?: string | null;
  priceUsd: number;
  discountPercent?: number;
  totalProduct: number;
  imageKeys?: string[];
}

export interface ProductResponse {
  id: string;
  userId: string;
  status: ProductStatus;
  name: string;
  description?: string | null;
  tag?: string | null;
  priceUsd: number;
  discountPercent: number;
  totalProduct: number;
  imageKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}
