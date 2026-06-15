import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventModel } from "../events/event.model.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserModel } from "../user/user.model.js";
import { PlanRepository } from "./plan.repository.js";
import type {
  CreatePlanDto,
  IPlan,
  ListPlansQuery,
  PlanEventSummary,
  PlanFriendSummary,
  PlanResponse,
  UpdatePlanDto,
} from "./plan.interface.js";

type LeanPlanEvent = {
  _id: unknown;
  name?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  location?: {
    searchLabel?: string | null;
    venue?: string | null;
    address?: string | null;
  } | null;
};

type LeanPlanFriend = {
  _id: unknown;
  name?: string | null;
  username?: string | null;
  avatarKey?: string | null;
};

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

    return this.toResponseWithDetails(plan);
  }

  public async listMyPlans(user: AuthUser, query: ListPlansQuery): Promise<PlanResponse[]> {
    const plans = await this.planRepository.findByUserId(user.id, query);

    return this.toResponsesWithDetails(plans);
  }

  public async getPlan(user: AuthUser, planId: string): Promise<PlanResponse> {
    const plan = await this.planRepository.findByIdForUser(planId, user.id);

    if (!plan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponseWithDetails(plan);
  }

  public async updatePlan(user: AuthUser, planId: string, payload: UpdatePlanDto): Promise<PlanResponse> {
    await this.assertFriendIdsAreAllowed(user.id, payload.friendIds ?? []);

    const plan = await this.planRepository.updateByIdForUser(planId, user.id, payload);

    if (!plan) {
      throw new AppError("Plan not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponseWithDetails(plan);
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

  private async toResponseWithDetails(plan: IPlan): Promise<PlanResponse> {
    const responses = await this.toResponsesWithDetails([plan]);

    return responses[0] ?? this.toResponse(plan, new Map(), new Map(), new Map());
  }

  private async toResponsesWithDetails(plans: IPlan[]): Promise<PlanResponse[]> {
    const eventIds = [
      ...new Set(plans.map((plan) => plan.eventId?.toString()).filter((eventId): eventId is string => Boolean(eventId))),
    ];
    const eventLookupValues = [
      ...new Set(
        plans
          .filter((plan) => !plan.eventId && plan.eventTitle)
          .flatMap((plan) => [plan.eventTitle?.trim(), plan.location.address?.trim()])
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const friendIds = [
      ...new Set(
        plans.flatMap((plan) => plan.friendIds.map((friendId) => friendId.toString())),
      ),
    ];

    const [events, friends] = await Promise.all([
      eventIds.length > 0 || eventLookupValues.length > 0
        ? EventModel.find({
            $or: [
              ...(eventIds.length > 0 ? [{ _id: { $in: eventIds } }] : []),
              ...(eventLookupValues.length > 0
                ? [
                    { name: { $in: eventLookupValues }, status: "published" },
                    { "location.venue": { $in: eventLookupValues }, status: "published" },
                    { "location.address": { $in: eventLookupValues }, status: "published" },
                    { "location.searchLabel": { $in: eventLookupValues }, status: "published" },
                  ]
                : []),
            ],
          })
            .select("_id name bannerImageKey bannerOriginalImageKey location")
            .lean<LeanPlanEvent[]>()
        : Promise.resolve([]),
      friendIds.length > 0
        ? UserModel.find({ _id: { $in: friendIds } })
            .select("_id name username avatarKey")
            .lean<LeanPlanFriend[]>()
        : Promise.resolve([]),
    ]);

    const eventMap = new Map<string, PlanEventSummary>();
    const eventTitleMap = new Map<string, PlanEventSummary>();
    for (const event of events) {
      const eventSummary = {
        id: String(event._id),
        title: event.name ?? null,
        bannerImageKey: event.bannerImageKey ?? null,
        bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
      };

      eventMap.set(String(event._id), eventSummary);

      if (event.name) {
        eventTitleMap.set(event.name.trim().toLowerCase(), eventSummary);
      }

      for (const locationValue of [
        event.location?.venue,
        event.location?.address,
        event.location?.searchLabel,
      ]) {
        if (locationValue) {
          eventTitleMap.set(locationValue.trim().toLowerCase(), eventSummary);
        }
      }
    }

    const friendMap = new Map<string, PlanFriendSummary>();
    for (const friend of friends) {
      const friendId = String(friend._id);

      friendMap.set(friendId, {
        id: friendId,
        name: friend.name ?? "Friend",
        username: friend.username ?? undefined,
        avatarKey: friend.avatarKey ?? null,
      });
    }

    return plans.map((plan) => this.toResponse(plan, eventMap, eventTitleMap, friendMap));
  }

  private toResponse(
    plan: IPlan,
    eventMap: Map<string, PlanEventSummary>,
    eventTitleMap: Map<string, PlanEventSummary>,
    friendMap: Map<string, PlanFriendSummary>,
  ): PlanResponse {
    const eventId = plan.eventId?.toString() ?? null;
    const eventTitleKey = plan.eventTitle?.trim().toLowerCase();
    const eventLocationKey = plan.location.address?.trim().toLowerCase();
    const event = eventId
      ? eventMap.get(eventId) ?? null
      : eventTitleKey
        ? eventTitleMap.get(eventTitleKey) ?? (eventLocationKey ? eventTitleMap.get(eventLocationKey) ?? null : null)
        : eventLocationKey
          ? eventTitleMap.get(eventLocationKey) ?? null
          : null;

    return {
      id: plan._id.toString(),
      userId: plan.userId.toString(),
      title: plan.title,
      scheduledAt: plan.scheduledAt,
      timeLabel: plan.timeLabel ?? null,
      eventId: plan.eventId?.toString() ?? null,
      eventTitle: plan.eventTitle ?? null,
      location: {
        address: plan.location.address,
        latitude: plan.location.latitude ?? null,
        longitude: plan.location.longitude ?? null,
      },
      friendIds: plan.friendIds.map((friendId) => friendId.toString()),
      friendNames: plan.friendNames,
      event,
      friends: plan.friendIds
        .map((friendId) => friendMap.get(friendId.toString()))
        .filter((friend): friend is PlanFriendSummary => Boolean(friend)),
      notes: plan.notes ?? null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}
