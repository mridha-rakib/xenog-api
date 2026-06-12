import { ProductModel } from "./product.model.js";
import type { CreateProductDto, IProduct } from "./product.interface.js";

interface CreateProductRecord extends CreateProductDto {
  userId: string;
}

export class ProductRepository {
  public async create(payload: CreateProductRecord): Promise<IProduct> {
    return ProductModel.create({
      userId: payload.userId,
      status: payload.status ?? "published",
      name: payload.name,
      description: payload.description ?? null,
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

  public async findPublishedByUserId(userId: string): Promise<IProduct[]> {
    return ProductModel.find({
      userId,
      $or: [{ status: "published" }, { status: { $exists: false } }],
    }).sort({ createdAt: -1, _id: -1 });
  }

  public async findByIdForUser(id: string, userId: string): Promise<IProduct | null> {
    return ProductModel.findOne({ _id: id, userId });
  }

  public async findPublishedById(id: string): Promise<IProduct | null> {
    return ProductModel.findOne({
      _id: id,
      $or: [{ status: "published" }, { status: { $exists: false } }],
    });
  }

  public async updateByIdForUser(id: string, userId: string, payload: CreateProductDto): Promise<IProduct | null> {
    return ProductModel.findOneAndUpdate(
      { _id: id, userId },
      {
        status: payload.status ?? "published",
        name: payload.name,
        description: payload.description ?? null,
        tag: payload.tag ?? null,
        priceUsd: payload.priceUsd,
        discountPercent: payload.discountPercent ?? 0,
        totalProduct: payload.totalProduct,
        imageKeys: payload.imageKeys ?? [],
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  public async deleteByIdForUser(id: string, userId: string): Promise<IProduct | null> {
    return ProductModel.findOneAndDelete({ _id: id, userId });
  }
}
