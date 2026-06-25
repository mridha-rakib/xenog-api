import { Schema, model } from "mongoose";

const schema = new Schema(
  {
    userId: { type: String, required: true },
    conversationId: { type: String, required: true },
  },
  { timestamps: { createdAt: "deletedAt", updatedAt: false }, versionKey: false },
);

schema.index({ userId: 1, conversationId: 1 }, { unique: true });

const ChatConversationDeletionModel = model("ChatConversationDeletion", schema);

export class ChatDeletionRepository {
  async hide(userId: string, conversationId: string): Promise<void> {
    await ChatConversationDeletionModel.findOneAndUpdate(
      { userId, conversationId },
      { $setOnInsert: { userId, conversationId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }

  async restore(userId: string, conversationId: string): Promise<void> {
    await ChatConversationDeletionModel.deleteOne({ userId, conversationId });
  }

  async findHiddenIds(userId: string): Promise<Set<string>> {
    const records = await ChatConversationDeletionModel.find({ userId })
      .select("conversationId")
      .lean();
    return new Set(records.map((r) => r.conversationId as string));
  }
}
