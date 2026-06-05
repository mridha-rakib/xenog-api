import { ProductModel } from "./product.model.js";
import type { CreateProductDto, IProduct } from "./product.interface.js";

interface CreateProductRecord extends CreateProductDto {
  userId: string;
}

export class ProductRepository {
  public async create(payload: CreateProductRecord): Promise<IProduct> {
    return ProductModel.create({
      userId: payload.userId,
      name: payload.name,
      description: payload.description ?? null,
      category: payload.category ?? null,
      tag: payload.tag ?? null,
      priceUsd: payload.priceUsd,
      discountPercent: payload.discountPercent ?? 0,
      totalProduct: payload.totalProduct,
      imageKeys: payload.imageKeys ?? [],
    });
  }

  public async findByUserId(userId: string): Promise<IProduct[]> {
    return ProductModel.find({ userId }).sort({ createdAt: -1 });
  }
}
