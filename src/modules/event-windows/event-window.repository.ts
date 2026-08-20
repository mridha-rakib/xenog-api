import mongoose, { Types } from "mongoose";
import type {
  CreateEventWindowDto,
  CreateEventWindowPostDto,
  EventWindowPostTicketEntitlement,
  IEventWindow,
  IEventWindowPost,
  ListEventWindowPostsOptions,
  UpdateEventWindowDto,
} from "./event-window.interface.js";
import {
  DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
  DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
  PARTICIPATED_POSTS_SCAN_LIMIT,
} from "./event-window.interface.js";
import { EventWindowModel, EventWindowPostModel } from "./event-window.model.js";

interface CreateWindowRecord extends CreateEventWindowDto {
  eventId: string;
  hostUserId: string;
}

// A post is authorized either by a check-in (ticketUsageId) or by a current
// ticket entitlement (ticketEntitlement), never both — see
// EventWindowService#resolvePostingAuthorization.
interface CreateWindowPostRecord extends CreateEventWindowPostDto {
  eventId: string;
  windowId: string;
  userId: string;
  ticketUsageId?: string | null;
  ticketEntitlement?: {
    orderId: string;
    ticketId: string;
    ticketIndex: number;
    source: EventWindowPostTicketEntitlement["source"];
  } | null;
}

export type CreatePostWithCapacityResult =
  | { status: "created"; window: IEventWindow; post: IEventWindowPost }
  | { status: "duplicate" }
  | { status: "unavailable" };

export interface ProfileWindowEventGroupRecord {
  eventId: Types.ObjectId;
  windowIds: Types.ObjectId[];
  windowCount: number;
  lastParticipatedAt: Date;
}

const isDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: number }).code === 11000;
};

export class EventWindowRepository {
  public async create(payload: CreateWindowRecord): Promise<IEventWindow> {
    return EventWindowModel.create({
      eventId: payload.eventId,
      hostUserId: payload.hostUserId,
      title: payload.title ?? null,
      details: payload.details ?? null,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      allowedContentTypes: payload.allowedContentTypes,
      maxPosts: payload.maxPosts,
      acceptedPostCount: 0,
      status: "scheduled",
      postingEligibility: payload.postingEligibility ?? DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
      participantPostVisibility: payload.participantPostVisibility ?? DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
      cancelledAt: null,
    });
  }

  public async findByEventId(eventId: string): Promise<IEventWindow[]> {
    return EventWindowModel.find({ eventId }).sort({ startsAt: 1, _id: 1 });
  }

  public async findByIds(windowIds: string[]): Promise<IEventWindow[]> {
    return windowIds.length > 0 ? EventWindowModel.find({ _id: { $in: windowIds } }) : [];
  }

  // Source query for the participated-events index — the caller's own
  // accepted posts, most recent first, bounded by PARTICIPATED_POSTS_SCAN_LIMIT
  // rather than the caller's full lifetime history. Uses the
  // {userId, status, createdAt} index (added specifically for this access
  // pattern — see event-window.model.ts).
  public async findAcceptedPostsByUser(userId: string): Promise<IEventWindowPost[]> {
    return EventWindowPostModel.find({ userId, status: "accepted" })
      .sort({ createdAt: -1, _id: -1 })
      .limit(PARTICIPATED_POSTS_SCAN_LIMIT);
  }

  public async countDistinctAcceptedWindowsByUser(userId: string): Promise<number> {
    const windowIds = await EventWindowPostModel.distinct("windowId", { userId, status: "accepted" });
    return windowIds.length;
  }

  public async countAcceptedPostEventGroupsByUser(userId: string): Promise<number> {
    const result = await EventWindowPostModel.aggregate<{ total: number }>([
      { $match: { userId: new Types.ObjectId(userId), status: "accepted" } },
      { $group: { _id: "$eventId" } },
      { $count: "total" },
    ]);

    return result[0]?.total ?? 0;
  }

  public async listAcceptedPostEventGroupsByUser(
    userId: string,
    skip: number,
    limit: number,
  ): Promise<ProfileWindowEventGroupRecord[]> {
    return EventWindowPostModel.aggregate<ProfileWindowEventGroupRecord>([
      { $match: { userId: new Types.ObjectId(userId), status: "accepted" } },
      {
        $group: {
          _id: "$eventId",
          windowIds: { $addToSet: "$windowId" },
          lastParticipatedAt: { $max: "$createdAt" },
        },
      },
      {
        $project: {
          _id: 0,
          eventId: "$_id",
          windowIds: 1,
          windowCount: { $size: "$windowIds" },
          lastParticipatedAt: 1,
        },
      },
      { $sort: { lastParticipatedAt: -1, eventId: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);
  }

  // Event start moving no longer invalidates a window (a window may start
  // before the event does), so only a window ending after the event's new
  // end time is a conflict. A null eventEndsAt (the event losing its end
  // time entirely) can't be validated against, so every non-cancelled
  // window is treated as conflicting in that case, matching prior behavior.
  public async findConflictingForEventSchedule(
    eventId: string,
    eventEndsAt: Date | null,
  ): Promise<IEventWindow[]> {
    return EventWindowModel.find({
      eventId,
      status: { $ne: "cancelled" },
      ...(eventEndsAt ? { endsAt: { $gt: eventEndsAt } } : {}),
    }).sort({ startsAt: 1, _id: 1 });
  }

  public async findByIdForEvent(eventId: string, windowId: string): Promise<IEventWindow | null> {
    return EventWindowModel.findOne({ _id: windowId, eventId });
  }

  public async updateByIdForEvent(
    eventId: string,
    windowId: string,
    payload: UpdateEventWindowDto,
  ): Promise<IEventWindow | null> {
    const update: Partial<IEventWindow> = {};

    if (payload.title !== undefined) update.title = payload.title ?? null;
    if (payload.details !== undefined) update.details = payload.details ?? null;
    if (payload.startsAt !== undefined) update.startsAt = payload.startsAt;
    if (payload.endsAt !== undefined) update.endsAt = payload.endsAt;
    if (payload.allowedContentTypes !== undefined) update.allowedContentTypes = payload.allowedContentTypes;
    if (payload.maxPosts !== undefined) update.maxPosts = payload.maxPosts;

    const filter: Record<string, unknown> = { _id: windowId, eventId };

    if (payload.maxPosts !== undefined) {
      filter.acceptedPostCount = { $lte: payload.maxPosts };
    }

    return EventWindowModel.findOneAndUpdate(filter, { $set: update }, {
      new: true,
      runValidators: true,
    });
  }

  public async cancelByIdForEvent(eventId: string, windowId: string): Promise<IEventWindow | null> {
    return EventWindowModel.findOneAndUpdate(
      { _id: windowId, eventId, status: { $ne: "cancelled" } },
      { $set: { status: "cancelled", cancelledAt: new Date() } },
      { new: true, runValidators: true },
    );
  }

  public async countAcceptedPosts(windowId: string): Promise<number> {
    return EventWindowPostModel.countDocuments({ windowId, status: "accepted" });
  }

  public async findAcceptedPostByUser(windowId: string, userId: string): Promise<IEventWindowPost | null> {
    return EventWindowPostModel.findOne({ windowId, userId, status: "accepted" });
  }

  public async findAcceptedPostByIdForWindow(windowId: string, postId: string): Promise<IEventWindowPost | null> {
    return EventWindowPostModel.findOne({ _id: postId, windowId, status: "accepted" });
  }

  public async listAcceptedPosts(
    windowId: string,
    options: ListEventWindowPostsOptions,
  ): Promise<IEventWindowPost[]> {
    return EventWindowPostModel.find({
      windowId,
      status: "accepted",
      ...(options.cursor ? { _id: { $gt: new Types.ObjectId(options.cursor) } } : {}),
    })
      .sort({ _id: 1 })
      .limit(options.limit + 1);
  }

  public async countAcceptedPostsByUserForEvent(userId: string, eventId: string): Promise<number> {
    return EventWindowPostModel.countDocuments({ userId, eventId, status: "accepted" });
  }

  public async listAcceptedPostsByUserForEvent(
    userId: string,
    eventId: string,
    skip: number,
    limit: number,
  ): Promise<IEventWindowPost[]> {
    return EventWindowPostModel.find({ userId, eventId, status: "accepted" })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit);
  }

  public async createPostWithCapacity(payload: CreateWindowPostRecord): Promise<CreatePostWithCapacityResult> {
    const session = await mongoose.startSession();

    try {
      let result: CreatePostWithCapacityResult = { status: "unavailable" };

      await session.withTransaction(async () => {
        const now = new Date();
        const existingPost = await EventWindowPostModel.findOne({
          windowId: payload.windowId,
          userId: payload.userId,
          status: "accepted",
        }).session(session);

        if (existingPost) {
          result = { status: "duplicate" };
          return;
        }

        const window = await EventWindowModel.findOneAndUpdate(
          {
            _id: payload.windowId,
            eventId: payload.eventId,
            status: "scheduled",
            startsAt: { $lte: now },
            endsAt: { $gt: now },
            allowedContentTypes: payload.contentType,
            $expr: { $lt: ["$acceptedPostCount", "$maxPosts"] },
          },
          { $inc: { acceptedPostCount: 1 } },
          { new: true, runValidators: true, session },
        );

        if (!window) {
          result = { status: "unavailable" };
          return;
        }

        let post: IEventWindowPost | undefined;
        try {
          [post] = await EventWindowPostModel.create(
            [{
              eventId: payload.eventId,
              windowId: payload.windowId,
              userId: payload.userId,
              ticketUsageId: payload.ticketUsageId ?? null,
              ticketEntitlement: payload.ticketEntitlement
                ? {
                  orderId: new Types.ObjectId(payload.ticketEntitlement.orderId),
                  ticketId: payload.ticketEntitlement.ticketId,
                  ticketIndex: payload.ticketEntitlement.ticketIndex,
                  source: payload.ticketEntitlement.source,
                }
                : null,
              contentType: payload.contentType,
              text: payload.text ?? null,
              mediaItems: payload.mediaItems ?? [],
              status: "accepted",
            }],
            { session },
          );
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            result = { status: "duplicate" };
            throw error;
          }

          throw error;
        }

        if (!post) {
          result = { status: "unavailable" };
          throw new Error("Event window post creation failed");
        }

        result = { status: "created", window, post };
      });

      return result;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { status: "duplicate" };
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }
}
