import { CartItemModel } from "./cart.model.js";
import type { ICartItem } from "./cart.interface.js";

export class CartRepository {
  public async findByUserId(userId: string): Promise<ICartItem[]> {
    return CartItemModel.find({ userId }).sort({ updatedAt: -1, _id: -1 });
  }

  public async findItem(userId: string, productId: string): Promise<ICartItem | null> {
    return CartItemModel.findOne({ userId, productId });
  }

  public async upsertItem(userId: string, productId: string, quantity: number): Promise<ICartItem> {
    return CartItemModel.findOneAndUpdate(
      { userId, productId },
      { userId, productId, quantity },
      {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true,
      },
    );
  }

  public async updateItem(userId: string, productId: string, quantity: number): Promise<ICartItem | null> {
    return CartItemModel.findOneAndUpdate(
      { userId, productId },
      { quantity },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  public async deleteItem(userId: string, productId: string): Promise<ICartItem | null> {
    return CartItemModel.findOneAndDelete({ userId, productId });
  }

  public async deleteItemsByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await CartItemModel.deleteMany({ _id: { $in: ids } });
  }

  public async clearByUserId(userId: string): Promise<void> {
    await CartItemModel.deleteMany({ userId });
  }
}
