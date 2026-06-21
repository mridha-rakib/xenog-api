import { MomentSaveModel } from "./moment-save.model.js";
import type { IMomentSave } from "./moment.interface.js";

export class MomentSaveRepository {
  public async toggleSave(userId: string, momentId: string): Promise<{ isSaved: boolean; save: IMomentSave | null }> {
    const existing = await MomentSaveModel.findOne({ userId, momentId });

    if (existing) {
      await MomentSaveModel.deleteOne({ _id: existing._id });

      return { isSaved: false, save: null };
    }

    const save = await MomentSaveModel.create({ userId, momentId });

    return { isSaved: true, save };
  }

  public async findByUserId(userId: string): Promise<IMomentSave[]> {
    return MomentSaveModel.find({ userId }).sort({ createdAt: -1 });
  }

  public async findSavedMomentIds(userId: string, momentIds: string[]): Promise<Set<string>> {
    if (momentIds.length === 0) {
      return new Set();
    }

    const saves = await MomentSaveModel.find({
      userId,
      momentId: { $in: momentIds },
    }).select("momentId");

    return new Set(saves.map((s) => s.momentId.toString()));
  }

  public async deleteByMomentId(momentId: string): Promise<void> {
    await MomentSaveModel.deleteMany({ momentId });
  }
}
