import { Schema, model } from "mongoose";
import type { Types } from "mongoose";

export interface IEventSave {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const eventSaveSchema = new Schema<IEventSave>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

eventSaveSchema.index({ userId: 1, eventId: 1 }, { unique: true });
eventSaveSchema.index({ userId: 1, createdAt: -1 });

export const EventSaveModel = model<IEventSave>("EventSave", eventSaveSchema);
