import { EventSaveModel } from "./event-save.model.js";

export class EventSaveRepository {
  public async toggleSave(userId: string, eventId: string): Promise<{ isSaved: boolean }> {
    const existing = await EventSaveModel.findOne({ userId, eventId });

    if (existing) {
      await EventSaveModel.deleteOne({ _id: existing._id });
      return { isSaved: false };
    }

    await EventSaveModel.create({ userId, eventId });
    return { isSaved: true };
  }

  public async isSaved(userId: string, eventId: string): Promise<boolean> {
    return Boolean(await EventSaveModel.exists({ userId, eventId }));
  }

  /**
   * Most-recently-saved Event ids for a user, newest first, capped at `limit`.
   * Read-only, single query — used to build Smart Feed behavioral relevance
   * context (bounded history, never a lifetime scan).
   */
  public async findRecentSavedEventIds(userId: string, limit: number): Promise<string[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const saves = await EventSaveModel.find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.floor(limit))
      .select("eventId");

    return saves.map((save) => save.eventId.toString());
  }

  public async findSavedEventIds(userId: string, eventIds: string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();

    const saves = await EventSaveModel.find({
      userId,
      eventId: { $in: eventIds },
    }).select("eventId");

    return new Set(saves.map((s) => s.eventId.toString()));
  }

  public async deleteByEventId(eventId: string): Promise<void> {
    await EventSaveModel.deleteMany({ eventId });
  }
}
