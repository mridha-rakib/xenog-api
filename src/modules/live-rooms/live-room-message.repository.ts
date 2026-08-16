import type { FilterQuery } from "mongoose";
import { LiveRoomMessageModel } from "./live-room-message.model.js";
import type { ILiveRoomMessage, ListLiveRoomMessagesQuery } from "./live-room.interface.js";

interface CreateLiveRoomMessageRecord {
  liveRoomId: string;
  senderId: string;
  text: string;
  clientMessageId?: string | null;
}

export class LiveRoomMessageRepository {
  public async create(payload: CreateLiveRoomMessageRecord): Promise<ILiveRoomMessage> {
    if (payload.clientMessageId) {
      const filter = { senderId: payload.senderId, clientMessageId: payload.clientMessageId };

      try {
        return await LiveRoomMessageModel.findOneAndUpdate(
          filter,
          {
            $setOnInsert: {
              liveRoomId: payload.liveRoomId,
              senderId: payload.senderId,
              text: payload.text,
              clientMessageId: payload.clientMessageId,
            },
          },
          { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const existing = await LiveRoomMessageModel.findOne(filter);
        if (existing) return existing;
        throw error;
      }
    }

    return LiveRoomMessageModel.create({
      liveRoomId: payload.liveRoomId,
      senderId: payload.senderId,
      text: payload.text,
    });
  }

  public async findByLiveRoomId(liveRoomId: string, query: ListLiveRoomMessagesQuery): Promise<ILiveRoomMessage[]> {
    const filter: FilterQuery<ILiveRoomMessage> = {
      liveRoomId,
    };

    if (query.before) {
      filter.createdAt = { $lt: query.before };
    }

    return LiveRoomMessageModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit ?? 50);
  }
}
