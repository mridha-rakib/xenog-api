import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { IProduct, ProductResponse } from "../products/product.interface.js";
import { ProductRepository } from "../products/product.repository.js";
import type { AddCartItemDto, CartItemResponse, CartResponse, ICartItem, UpdateCartItemDto } from "./cart.interface.js";
import { CartRepository } from "./cart.repository.js";

export class CartService {
  public constructor(
    private readonly cartRepository = new CartRepository(),
    private readonly productRepository = new ProductRepository(),
  ) {}

  public async getCart(user: AuthUser): Promise<CartResponse> {
    return this.buildCartResponse(user.id, await this.cartRepository.findByUserId(user.id), true);
  }

  public async addItem(user: AuthUser, payload: AddCartItemDto): Promise<CartResponse> {
    const product = await this.getAvailableProduct(payload.productId);
    const existingItem = await this.cartRepository.findItem(user.id, payload.productId);
    const nextQuantity = (existingItem?.quantity ?? 0) + (payload.quantity ?? 1);

    this.assertQuantityInStock(nextQuantity, product);
    await this.cartRepository.upsertItem(user.id, payload.productId, nextQuantity);

    return this.getCart(user);
  }

  public async updateItem(user: AuthUser, productId: string, payload: UpdateCartItemDto): Promise<CartResponse> {
    const product = await this.getAvailableProduct(productId);

    this.assertQuantityInStock(payload.quantity, product);

    const item = await this.cartRepository.updateItem(user.id, productId, payload.quantity);

    if (!item) {
      throw new AppError("Cart item not found.", httpStatus.NOT_FOUND);
    }

    return this.getCart(user);
  }

  public async removeItem(user: AuthUser, productId: string): Promise<CartResponse> {
    await this.cartRepository.deleteItem(user.id, productId);

    return this.getCart(user);
  }

  public async clearCart(user: AuthUser): Promise<CartResponse> {
    await this.cartRepository.clearByUserId(user.id);

    return this.getCart(user);
  }

  private async getAvailableProduct(productId: string): Promise<IProduct> {
    const product = await this.productRepository.findPublishedById(productId);

    if (!product) {
      throw new AppError("Product not found.", httpStatus.NOT_FOUND);
    }

    if (product.totalProduct <= 0) {
      throw new AppError("This product is out of stock.", httpStatus.CONFLICT);
    }

    return product;
  }

  private assertQuantityInStock(quantity: number, product: IProduct): void {
    if (quantity > product.totalProduct) {
      throw new AppError(
        `Only ${product.totalProduct} ${product.totalProduct === 1 ? "item is" : "items are"} available.`,
        httpStatus.CONFLICT,
        {
          code: "PRODUCT_STOCK_LIMIT_EXCEEDED",
          productId: product._id.toString(),
          availableStock: product.totalProduct,
          requestedQuantity: quantity,
        },
      );
    }
  }

  private async buildCartResponse(
    userId: string,
    cartItems: ICartItem[],
    normalizeStock: boolean,
  ): Promise<CartResponse> {
    const productIds = cartItems.map((item) => item.productId.toString());
    const products = await this.productRepository.findPublishedByIds(productIds);
    const productById = new Map(products.map((product) => [product._id.toString(), product]));
    const invalidItemIds: string[] = [];
    const itemsToClamp: Array<{ item: ICartItem; quantity: number }> = [];
    const responseItems: CartItemResponse[] = [];

    for (const item of cartItems) {
      const product = productById.get(item.productId.toString());

      if (!product || product.totalProduct <= 0) {
        invalidItemIds.push(item._id.toString());
        continue;
      }

      const quantity = Math.min(item.quantity, product.totalProduct);

      if (normalizeStock && quantity !== item.quantity) {
        itemsToClamp.push({ item, quantity });
      }

      responseItems.push(this.toCartItemResponse(item, product, quantity));
    }

    await Promise.all([
      this.cartRepository.deleteItemsByIds(invalidItemIds),
      ...itemsToClamp.map(({ item, quantity }) =>
        this.cartRepository.updateItem(userId, item.productId.toString(), quantity),
      ),
    ]);

    return {
      items: responseItems,
      totalQuantity: responseItems.reduce((total, item) => total + item.quantity, 0),
      subtotalUsd: responseItems.reduce((total, item) => total + item.lineTotalUsd, 0),
    };
  }

  private toCartItemResponse(item: ICartItem, product: IProduct, quantity: number): CartItemResponse {
    const unitPriceUsd = this.getDiscountedPrice(product);

    return {
      id: item._id.toString(),
      productId: product._id.toString(),
      quantity,
      unitPriceUsd,
      lineTotalUsd: unitPriceUsd * quantity,
      stockQuantity: product.totalProduct,
      product: this.toProductResponse(product),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private getDiscountedPrice(product: IProduct): number {
    return product.discountPercent > 0 ? product.priceUsd * (1 - product.discountPercent / 100) : product.priceUsd;
  }

  private toProductResponse(product: IProduct): ProductResponse {
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
