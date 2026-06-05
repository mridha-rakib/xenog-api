import { MomentModel } from "./moment.model.js";
import type { CreateMomentDto, IMoment } from "./moment.interface.js";

interface CreateMomentRecord extends CreateMomentDto {
  userId: string;
}

export class MomentRepository {
  public async create(payload: CreateMomentRecord): Promise<IMoment> {
    return MomentModel.create({
      userId: payload.userId,
      mode: payload.mode,
      caption: payload.caption ?? null,
      audience: payload.audience,
      taggedPeople: payload.taggedPeople ?? [],
      eventTitle: payload.eventTitle ?? null,
      eventCode: payload.eventCode ?? null,
      mediaItems: payload.mediaItems ?? [],
    });
  }

  public async findByUserId(userId: string): Promise<IMoment[]> {
    return MomentModel.find({ userId }).sort({ createdAt: -1 });
  }

  public async findByUserIdForProfile(userId: string, includePrivate: boolean): Promise<IMoment[]> {
    return MomentModel.find({
      userId,
      ...(includePrivate ? {} : { audience: "public" }),
    }).sort({ createdAt: -1 });
  }

  public async findById(id: string): Promise<IMoment | null> {
    return MomentModel.findById(id);
  }

  public async deleteByIdForUser(id: string, userId: string): Promise<IMoment | null> {
    return MomentModel.findOneAndDelete({ _id: id, userId });
  }

  public async findByIds(ids: string[]): Promise<IMoment[]> {
    if (ids.length === 0) {
      return [];
    }

    return MomentModel.find({ _id: { $in: ids } });
  }

  public async countByUserId(userId: string, includePrivate: boolean): Promise<number> {
    return MomentModel.countDocuments({
      userId,
      ...(includePrivate ? {} : { audience: "public" }),
    });
  }

  public async findFeed(limit = 50): Promise<IMoment[]> {
    return MomentModel.find({
      mode: "feed",
      audience: "public",
    })
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}
