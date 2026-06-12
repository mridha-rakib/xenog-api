import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
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

  public async listPublishedProductsByUser(userId: string): Promise<ProductResponse[]> {
    const products = await this.productRepository.findPublishedByUserId(userId);

    return products.map((product) => this.toResponse(product));
  }

  public async getMyProduct(user: AuthUser, productId: string): Promise<ProductResponse> {
    const product = await this.productRepository.findByIdForUser(productId, user.id);

    if (!product) {
      throw new AppError("Product not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(product);
  }

  public async getPublishedProduct(productId: string): Promise<ProductResponse> {
    const product = await this.productRepository.findPublishedById(productId);

    if (!product) {
      throw new AppError("Product not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(product);
  }

  public async updateMyProduct(user: AuthUser, productId: string, payload: CreateProductDto): Promise<ProductResponse> {
    const product = await this.productRepository.updateByIdForUser(productId, user.id, {
      ...payload,
      name: payload.name.trim(),
      description: payload.description?.trim() || null,
      tag: payload.tag?.trim() || null,
    });

    if (!product) {
      throw new AppError("Product not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(product);
  }

  public async deleteMyProduct(user: AuthUser, productId: string): Promise<void> {
    const product = await this.productRepository.deleteByIdForUser(productId, user.id);

    if (!product) {
      throw new AppError("Product not found.", httpStatus.NOT_FOUND);
    }
  }

  private toResponse(product: IProduct): ProductResponse {
    return {
      id: product._id.toString(),
      userId: product.userId.toString(),
      status: product.status ?? "published",
      name: product.name,
      description: product.description ?? null,
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
