import { UserBlockModel } from "./user-block.model.js";

export class UserBlockRepository {
  public async block(blockerId: string, blockedId: string): Promise<void> {
    await UserBlockModel.findOneAndUpdate(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId } },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async unblock(blockerId: string, blockedId: string): Promise<void> {
    await UserBlockModel.deleteOne({ blockerId, blockedId });
  }

  public async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    return Boolean(await UserBlockModel.exists({ blockerId, blockedId }));
  }

  public async findBlockedIds(blockerId: string): Promise<string[]> {
    const ids = await UserBlockModel.distinct("blockedId", { blockerId });
    return ids.map((id) => id.toString());
  }
}
