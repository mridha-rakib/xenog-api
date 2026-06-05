import type { AuthUser } from "../auth/auth.interface.js";
import { ProductRepository } from "./product.repository.js";
import type { CreateProductDto, IProduct, ProductResponse } from "./product.interface.js";

export class ProductService {
  public constructor(private readonly productRepository = new ProductRepository()) {}

  public async createProduct(payload: CreateProductDto, user: AuthUser): Promise<ProductResponse> {
    const product = await this.productRepository.create({
      userId: user.id,
      name: payload.name.trim(),
      description: payload.description?.trim() || null,
      category: payload.category?.trim() || null,
      tag: payload.tag?.trim() || null,
      priceUsd: payload.priceUsd,
      discountPercent: payload.discountPercent ?? 0,
      totalProduct: payload.totalProduct,
      imageKeys: payload.imageKeys ?? [],
    });

    return this.toResponse(product);
  }

  public async listMyProducts(user: AuthUser): Promise<ProductResponse[]> {
    const products = await this.productRepository.findByUserId(user.id);

    return products.map((product) => this.toResponse(product));
  }

  private toResponse(product: IProduct): ProductResponse {
    return {
      id: product._id.toString(),
      userId: product.userId.toString(),
      name: product.name,
      description: product.description ?? null,
      category: product.category ?? null,
      tag: product.tag ?? null,
      priceUsd: product.priceUsd,
      discountPercent: product.discountPercent,
      totalProduct: product.totalProduct,
      imageKeys: product.imageKeys,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
