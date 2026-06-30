import { FcmTokenModel } from "./fcm-token.model.js";

export class FcmTokenRepository {
  async upsert(userId: string, token: string, platform?: string, deviceId?: string): Promise<void> {
    await FcmTokenModel.updateOne(
      { userId, token },
      { $set: { userId, token, platform: platform ?? "android", deviceId: deviceId ?? null } },
      { upsert: true },
    );
  }

  async remove(userId: string, token: string): Promise<void> {
    await FcmTokenModel.deleteOne({ userId, token });
  }

  async removeInvalidTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await FcmTokenModel.deleteMany({ token: { $in: tokens } });
  }

  async findTokensForUsers(userIds: string[]): Promise<Array<{ userId: string; token: string }>> {
    if (userIds.length === 0) return [];
    const docs = await FcmTokenModel.find({ userId: { $in: userIds } }).lean();
    return docs.map((d) => ({ userId: d.userId.toString(), token: d.token }));
  }
}
