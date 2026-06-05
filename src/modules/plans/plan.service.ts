import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { PlanRepository } from "./plan.repository.js";
import type { CreatePlanDto, IPlan, ListPlansQuery, PlanResponse, UpdatePlanDto } from "./plan.interface.js";

export class PlanService {
  public constructor(
    private readonly planRepository = new PlanRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
  ) {}

  public async createPlan(user: AuthUser, payload: CreatePlanDto): Promise<PlanResponse> {
    await this.assertFriendIdsAreAllowed(user.id, payload.friendIds ?? []);

    const plan = await this.planRepository.create({
      ...payload,
      userId: user.id,
    });

    return this.toResponse(plan);
  }

  public async listMyPlans(user: AuthUser, query: ListPlansQuery): Promise<PlanResponse[]> {
    const plans = await this.planRepository.findByUserId(user.id, query);

    return plans.map((plan) => this.toResponse(plan));
  }

  public async getPlan(user: AuthUser, planId: string): Promise<PlanResponse> {
    const plan = await this.planRepository.findByIdForUser(planId, user.id);

    if (!plan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(plan);
  }

  public async updatePlan(user: AuthUser, planId: string, payload: UpdatePlanDto): Promise<PlanResponse> {
    await this.assertFriendIdsAreAllowed(user.id, payload.friendIds ?? []);

    const plan = await this.planRepository.updateByIdForUser(planId, user.id, payload);

    if (!plan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(plan);
  }

  public async deletePlan(user: AuthUser, planId: string): Promise<void> {
    const plan = await this.planRepository.deleteByIdForUser(planId, user.id);

    if (!plan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }
  }

  private async assertFriendIdsAreAllowed(userId: string, friendIds: string[]): Promise<void> {
    if (friendIds.length === 0) {
      return;
    }

    const mutualFriendIds = await this.userFollowRepository.findMutualFriendIds(userId);
    const mutualFriendIdSet = new Set(mutualFriendIds);
    const invalidFriendId = friendIds.find((friendId) => !mutualFriendIdSet.has(friendId));

    if (invalidFriendId) {
      throw new AppError("Plans can only include mutual friends.", httpStatus.FORBIDDEN);
    }
  }

  private toResponse(plan: IPlan): PlanResponse {
    return {
      id: plan._id.toString(),
      userId: plan.userId.toString(),
      title: plan.title,
      scheduledAt: plan.scheduledAt,
      timeLabel: plan.timeLabel ?? null,
      eventTitle: plan.eventTitle ?? null,
      location: {
        address: plan.location.address,
        latitude: plan.location.latitude ?? null,
        longitude: plan.location.longitude ?? null,
      },
      friendIds: plan.friendIds.map((friendId) => friendId.toString()),
      friendNames: plan.friendNames,
      notes: plan.notes ?? null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}
