import { LiveRoomParticipantModel } from "./live-room-participant.model.js";
import type { ILiveRoomParticipant } from "./live-room.interface.js";

export class LiveRoomParticipantRepository {
  public async join(liveRoomId: string, userId: string): Promise<ILiveRoomParticipant> {
    return LiveRoomParticipantModel.findOneAndUpdate(
      { liveRoomId, userId },
      {
        $set: {
          isActive: true,
          joinedAt: new Date(),
          leftAt: null,
        },
      },
      { new: true, runValidators: true, setDefaultsOnInsert: true, upsert: true },
    );
  }

  public async leave(liveRoomId: string, userId: string): Promise<ILiveRoomParticipant | null> {
    return LiveRoomParticipantModel.findOneAndUpdate(
      { liveRoomId, userId, isActive: true },
      {
        $set: {
          isActive: false,
          leftAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async findActiveByLiveRoomId(liveRoomId: string): Promise<ILiveRoomParticipant[]> {
    return LiveRoomParticipantModel.find({ liveRoomId, isActive: true }).sort({ joinedAt: 1, _id: 1 });
  }

  public async countActiveByLiveRoomId(liveRoomId: string): Promise<number> {
    return LiveRoomParticipantModel.countDocuments({ liveRoomId, isActive: true });
  }
}
