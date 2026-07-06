import { Schema, model } from "mongoose";
import type { IEventHostReview } from "./event-host-review.interface.js";

const eventHostReviewSchema = new Schema<IEventHostReview>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    hostUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reviewerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ticketUsageId: {
      type: Schema.Types.ObjectId,
      ref: "TicketUsage",
      required: true,
      index: true,
    },
    rating: {
      type: String,
      enum: ["like", "dislike"],
      required: true,
    },
    text: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

eventHostReviewSchema.index({ eventId: 1, reviewerUserId: 1 }, { unique: true });
eventHostReviewSchema.index({ hostUserId: 1, createdAt: -1, _id: -1 });

export const EventHostReviewModel = model<IEventHostReview>("EventHostReview", eventHostReviewSchema);

export const ensureEventHostReviewIndexes = async (): Promise<void> => {
  await EventHostReviewModel.syncIndexes();
};
