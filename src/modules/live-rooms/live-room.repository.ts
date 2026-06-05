import type { UpdateQuery } from "mongoose";
import { LiveRoomModel } from "./live-room.model.js";
import type { CreateLiveRoomDto, ILiveRoom, UpdateLiveRoomPermissionsDto } from "./live-room.interface.js";

interface CreateLiveRoomRecord extends CreateLiveRoomDto {
  hostUserId: string;
}

export class LiveRoomRepository {
  public async create(payload: CreateLiveRoomRecord): Promise<ILiveRoom> {
    return LiveRoomModel.create({
      hostUserId: payload.hostUserId,
      title: payload.title,
      allowAllParticipantsToSpeak: payload.allowAllParticipantsToSpeak,
      speakerIds: payload.speakerIds ?? [],
      status: "live",
    });
  }

  public async findById(id: string): Promise<ILiveRoom | null> {
    return LiveRoomModel.findById(id);
  }

  public async updatePermissionsByIdForHost(
    id: string,
    hostUserId: string,
    payload: UpdateLiveRoomPermissionsDto,
  ): Promise<ILiveRoom | null> {
    const update: UpdateQuery<ILiveRoom> = {};

    if (payload.allowAllParticipantsToSpeak !== undefined) {
      update.allowAllParticipantsToSpeak = payload.allowAllParticipantsToSpeak;
    }

    if (payload.speakerIds !== undefined) {
      update.speakerIds = payload.speakerIds;
    }

    return LiveRoomModel.findOneAndUpdate({ _id: id, hostUserId }, update, { new: true, runValidators: true });
  }
}
