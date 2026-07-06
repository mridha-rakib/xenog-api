import { Types } from "mongoose";
import type { IEventHostReview, SubmitEventHostReviewDto } from "./event-host-review.interface.js";
import { EventHostReviewModel } from "./event-host-review.model.js";

type CreateEventHostReviewRecord = SubmitEventHostReviewDto & {
  eventId: string;
  hostUserId: string;
  reviewerUserId: string;
  ticketUsageId: string;
};

export class EventHostReviewRepository {
  public async create(payload: CreateEventHostReviewRecord): Promise<IEventHostReview> {
    return EventHostReviewModel.create({
      eventId: new Types.ObjectId(payload.eventId),
      hostUserId: new Types.ObjectId(payload.hostUserId),
      reviewerUserId: new Types.ObjectId(payload.reviewerUserId),
      ticketUsageId: new Types.ObjectId(payload.ticketUsageId),
      rating: payload.liked ? "like" : "dislike",
      text: payload.text?.trim() || null,
    });
  }

  public async findByEventIdAndReviewerUserId(
    eventId: string,
    reviewerUserId: string,
  ): Promise<IEventHostReview | null> {
    return EventHostReviewModel.findOne({
      eventId,
      reviewerUserId,
    });
  }

  public async findByHostUserId(hostUserId: string, limit = 100): Promise<IEventHostReview[]> {
    return EventHostReviewModel.find({ hostUserId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
  }

  public async countByHostUserId(hostUserId: string): Promise<number> {
    return EventHostReviewModel.countDocuments({ hostUserId });
  }
}
