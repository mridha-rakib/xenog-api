import { MomentModel } from "./moment.model.js";
import type { CreateMomentDto, IMoment, MomentFeedQuery } from "./moment.interface.js";

interface CreateMomentRecord extends CreateMomentDto {
  userId: string;
  hashtags: string[];
  sourceStoryId?: string | null;
  sourceClientRequestId?: string | null;
}

export class MomentRepository {
  public async create(payload: CreateMomentRecord): Promise<IMoment> {
    return MomentModel.create({
      userId: payload.userId,
      mode: payload.mode,
      caption: payload.caption ?? null,
      hashtags: payload.hashtags,
      audience: payload.audience,
      taggedPeople: payload.taggedPeople ?? [],
      taggedFriendIds: payload.taggedFriendIds ?? [],
      eventTitle: payload.eventTitle ?? null,
      eventId: payload.eventId ?? null,
      isEventAnnouncement: false,
      eventCode: payload.eventCode ?? null,
      sourceStoryId: payload.sourceStoryId ?? null,
      sourceClientRequestId: payload.sourceClientRequestId ?? null,
      mediaItems: payload.mediaItems ?? [],
    });
  }

  public async createStoryShare(payload: CreateMomentRecord & { sourceStoryId: string }): Promise<IMoment> {
    return MomentModel.findOneAndUpdate(
      { userId: payload.userId, sourceStoryId: payload.sourceStoryId },
      {
        $setOnInsert: {
          userId: payload.userId,
          mode: payload.mode,
          caption: payload.caption ?? null,
          hashtags: payload.hashtags,
          audience: payload.audience,
          taggedPeople: payload.taggedPeople ?? [],
          taggedFriendIds: payload.taggedFriendIds ?? [],
          eventTitle: payload.eventTitle ?? null,
          eventId: payload.eventId ?? null,
          isEventAnnouncement: false,
          eventCode: payload.eventCode ?? null,
          sourceStoryId: payload.sourceStoryId,
          sourceClientRequestId: payload.sourceClientRequestId ?? null,
          mediaItems: payload.mediaItems ?? [],
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async ensureEventAnnouncement(payload: {
    eventId: string;
    userId: string;
    eventTitle?: string | null;
    caption?: string | null;
  }): Promise<IMoment> {
    return MomentModel.findOneAndUpdate(
      { eventId: payload.eventId, isEventAnnouncement: true },
      {
        $set: {
          userId: payload.userId,
          mode: "event",
          caption: payload.caption ?? null,
          audience: "public",
          eventTitle: payload.eventTitle ?? null,
        },
        $setOnInsert: {
          hashtags: [],
          taggedPeople: [],
          taggedFriendIds: [],
          eventId: payload.eventId,
          isEventAnnouncement: true,
          eventCode: null,
          mediaItems: [],
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async findByEventId(eventId: string, limit = 50): Promise<IMoment[]> {
    return MomentModel.find({
      audience: "public",
      eventId,
      isEventAnnouncement: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  public async findEventAnnouncement(eventId: string): Promise<IMoment | null> {
    return MomentModel.findOne({ eventId, isEventAnnouncement: true });
  }

  public async deleteEventAnnouncement(eventId: string): Promise<void> {
    await MomentModel.deleteOne({ eventId, isEventAnnouncement: true });
  }

  public async findByUserId(userId: string): Promise<IMoment[]> {
    return MomentModel.find({ userId, isEventAnnouncement: { $ne: true } }).sort({ createdAt: -1 });
  }

  public async findByUserIdForProfile(
    userId: string,
    includePrivate: boolean,
    options: { limit?: number; skip?: number } = {},
  ): Promise<IMoment[]> {
    return MomentModel.find({
      userId,
      isEventAnnouncement: { $ne: true },
      ...(includePrivate ? {} : { audience: "public" }),
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip(options.skip ?? 0)
      .limit(options.limit ?? 0);
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
      isEventAnnouncement: { $ne: true },
      ...(includePrivate ? {} : { audience: "public" }),
    });
  }

  public async findFeed(query: MomentFeedQuery = {}): Promise<IMoment[]> {
    const hashtags = query.hashtags?.filter(Boolean) ?? [];
    const excludeUserIds = query.excludeUserIds ?? [];

    return MomentModel.find({
      mode: "feed",
      audience: "public",
      ...(hashtags.length > 0 ? { hashtags: { $all: hashtags } } : {}),
      ...(excludeUserIds.length > 0 ? { userId: { $nin: excludeUserIds } } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(query.limit ?? 50);
  }

  public async findPublicByHashtag(hashtag: string, limit = 100): Promise<IMoment[]> {
    return MomentModel.find({ audience: "public", hashtags: hashtag, isEventAnnouncement: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}
