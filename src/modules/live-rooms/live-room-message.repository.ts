import type { FilterQuery } from "mongoose";
import { LiveRoomMessageModel } from "./live-room-message.model.js";
import type { ILiveRoomMessage, ListLiveRoomMessagesQuery } from "./live-room.interface.js";

interface CreateLiveRoomMessageRecord {
  liveRoomId: string;
  senderId: string;
  text: string;
}

export class LiveRoomMessageRepository {
  public async create(payload: CreateLiveRoomMessageRecord): Promise<ILiveRoomMessage> {
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
