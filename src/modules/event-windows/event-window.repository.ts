import mongoose, { Types } from "mongoose";
import type {
  CreateEventWindowDto,
  CreateEventWindowPostDto,
  IEventWindow,
  IEventWindowPost,
  ListEventWindowPostsOptions,
  UpdateEventWindowDto,
} from "./event-window.interface.js";
import { EventWindowModel, EventWindowPostModel } from "./event-window.model.js";

interface CreateWindowRecord extends CreateEventWindowDto {
  eventId: string;
  hostUserId: string;
}

interface CreateWindowPostRecord extends CreateEventWindowPostDto {
  eventId: string;
  windowId: string;
  userId: string;
  ticketUsageId: string;
}

export type CreatePostWithCapacityResult =
  | { status: "created"; window: IEventWindow; post: IEventWindowPost }
  | { status: "duplicate" }
  | { status: "unavailable" };

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
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      allowedContentTypes: payload.allowedContentTypes,
      maxPosts: payload.maxPosts,
      acceptedPostCount: 0,
      status: "scheduled",
      cancelledAt: null,
    });
  }

  public async findByEventId(eventId: string): Promise<IEventWindow[]> {
    return EventWindowModel.find({ eventId }).sort({ startsAt: 1, _id: 1 });
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
              ticketUsageId: payload.ticketUsageId,
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
