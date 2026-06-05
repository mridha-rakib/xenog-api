import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import type { ChatMessageType, IChatMessage } from "./chat.interface.js";
import { ChatMessageModel } from "./chat-message.model.js";

interface CreateChatMessageRecord {
  conversationId: string;
  senderId: string;
  recipientId: string;
  type?: ChatMessageType;
  text: string;
}

export class ChatMessageRepository {
  public async create(payload: CreateChatMessageRecord): Promise<IChatMessage> {
    return ChatMessageModel.create({
      conversationId: payload.conversationId,
      senderId: payload.senderId,
      recipientId: payload.recipientId,
      type: payload.type ?? "text",
      text: payload.text,
    });
  }

  public async findConversationMessages(
    conversationId: string,
    limit: number,
    before?: Date,
  ): Promise<IChatMessage[]> {
    const filter: FilterQuery<IChatMessage> = {
      conversationId,
    };

    if (before) {
      filter.createdAt = { $lt: before };
    }

    return ChatMessageModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit);
  }

  public async findLatestByConversationIds(conversationIds: string[]): Promise<Map<string, IChatMessage>> {
    if (conversationIds.length === 0) {
      return new Map();
    }

    const messages = await ChatMessageModel.aggregate<IChatMessage>([
      {
        $match: {
          conversationId: { $in: conversationIds },
        },
      },
      {
        $sort: {
          createdAt: -1,
          _id: -1,
        },
      },
      {
        $group: {
          _id: "$conversationId",
          message: { $first: "$$ROOT" },
        },
      },
      {
        $replaceRoot: {
          newRoot: "$message",
        },
      },
    ]);

    return new Map(messages.map((message) => [message.conversationId, message]));
  }

  public async countUnreadByConversationIds(
    userId: string,
    conversationIds: string[],
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) {
      return new Map();
    }

    const counts = await ChatMessageModel.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          conversationId: { $in: conversationIds },
          readAt: null,
          recipientId: new Types.ObjectId(userId),
        },
      },
      {
        $group: {
          _id: "$conversationId",
          count: { $sum: 1 },
        },
      },
    ]);

    return new Map(counts.map((count) => [count._id, count.count]));
  }

  public async markConversationRead(conversationId: string, userId: string): Promise<void> {
    await ChatMessageModel.updateMany(
      {
        conversationId,
        readAt: null,
        recipientId: userId,
      },
      {
        $set: {
          readAt: new Date(),
        },
      },
    );
  }
}
