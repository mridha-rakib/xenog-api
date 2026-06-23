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
