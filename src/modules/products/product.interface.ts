import type { Types } from "mongoose";

export interface IProduct {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
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
