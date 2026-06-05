import type { FilterQuery, UpdateQuery } from "mongoose";
import { PlanModel } from "./plan.model.js";
import type { CreatePlanDto, IPlan, ListPlansQuery, UpdatePlanDto } from "./plan.interface.js";

interface CreatePlanRecord extends CreatePlanDto {
  userId: string;
}

export class PlanRepository {
  public async create(payload: CreatePlanRecord): Promise<IPlan> {
    return PlanModel.create({
      userId: payload.userId,
      title: payload.title,
      scheduledAt: payload.scheduledAt,
      timeLabel: payload.timeLabel ?? null,
      eventTitle: payload.eventTitle ?? null,
      location: payload.location,
      friendIds: payload.friendIds ?? [],
      friendNames: payload.friendNames ?? [],
      notes: payload.notes ?? null,
    });
  }

  public async findByUserId(userId: string, query: ListPlansQuery): Promise<IPlan[]> {
    const filter: FilterQuery<IPlan> = {
      userId,
    };

    if (query.from || query.to) {
      filter.scheduledAt = {};

      if (query.from) {
        filter.scheduledAt.$gte = query.from;
      }

      if (query.to) {
        filter.scheduledAt.$lte = query.to;
      }
    }

    return PlanModel.find(filter)
      .sort({ scheduledAt: 1, _id: 1 })
      .limit(query.limit ?? 500);
  }

  public async findByIdForUser(id: string, userId: string): Promise<IPlan | null> {
    return PlanModel.findOne({ _id: id, userId });
  }

  public async updateByIdForUser(id: string, userId: string, payload: UpdatePlanDto): Promise<IPlan | null> {
    const update: UpdateQuery<IPlan> = payload;

    return PlanModel.findOneAndUpdate({ _id: id, userId }, update, { new: true, runValidators: true });
  }

  public async deleteByIdForUser(id: string, userId: string): Promise<IPlan | null> {
    return PlanModel.findOneAndDelete({ _id: id, userId });
  }
}
