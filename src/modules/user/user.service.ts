import httpStatus from "http-status";
import bcrypt from "bcryptjs";
import { AppError } from "../../core/errors/app-error.js";
import {
  createPaginationMeta,
  getPaginationOptions,
  type PaginatedResult,
} from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import { StorageService } from "../storage/storage.service.js";
import type {
  AdminManagedUserResponse,
  AdminUserStatsResponse,
  BlockStatusResponse,
  CreateUserDto,
  FollowStatusResponse,
  FriendUserResponse,
  IUser,
  ProfileFollowUserResponse,
  SuggestedUserResponse,
  UpdateUserDto,
  UserProfileStatsResponse,
  UserResponse,
  UserReviewResponse,
} from "./user.interface.js";
import { UserFollowRepository } from "./user-follow.repository.js";
import { UserBlockRepository } from "./user-block.repository.js";
import { UserRepository } from "./user.repository.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { realtimeGateway } from "../realtime/realtime.gateway.js";
import { EventHostReviewRepository } from "../events/event-host-review.repository.js";

interface ListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  role?: "user" | "admin";
  isActive?: boolean;
}

interface ListProfileUsersQuery {
  search?: string;
  limit?: number;
}

interface AdminListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
  accountType?: "personal" | "business";
}

export class UserService {
  public constructor(
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly userBlockRepository = new UserBlockRepository(),
    private readonly storageService = new StorageService(),
    private readonly notificationRepository = new NotificationRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly eventHostReviewRepository = new EventHostReviewRepository(),
  ) {}

  public async create(payload: CreateUserDto): Promise<IUser> {
    const existingUser = await this.userRepository.findByEmail(payload.email);

    if (existingUser) {
      throw new AppError("Email already exists", httpStatus.CONFLICT);
    }

    if (payload.username) {
      const existingUsername = await this.userRepository.findByUsername(payload.username);

      if (existingUsername) {
        throw new AppError("Username already exists", httpStatus.CONFLICT);
      }
    }

    const { password, ...userPayload } = payload;
    const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;

    return this.userRepository.create({
      ...userPayload,
      ...(userPayload.username ? { username: userPayload.username.toLowerCase() } : {}),
      ...(passwordHash ? { passwordHash } : {}),
      emailVerified: true,
    });
  }

  public async list(query: ListUsersQuery): Promise<PaginatedResult<IUser>> {
    const { page, limit, skip } = getPaginationOptions(query);
    const filter: Record<string, unknown> = {};

    if (query.search) {
      filter.$or = [
        { name: { $regex: query.search, $options: "i" } },
        { email: { $regex: query.search, $options: "i" } },
        { username: { $regex: query.search, $options: "i" } },
      ];
    }

    if (query.role) {
      filter.role = query.role;
    }

    if (typeof query.isActive === "boolean") {
      filter.isActive = query.isActive;
    }

    const [data, total] = await Promise.all([
      this.userRepository.findMany(filter, skip, limit),
      this.userRepository.count(filter),
    ]);

    return {
      data,
      meta: createPaginationMeta(page, limit, total),
    };
  }

  public async listForAdmin(query: AdminListUsersQuery): Promise<{
    data: AdminManagedUserResponse[];
    meta: ReturnType<typeof createPaginationMeta>;
    stats: AdminUserStatsResponse;
  }> {
    const { page, limit, skip } = getPaginationOptions(query);
    const activeUserFilter: Record<string, unknown> = {
      role: "user",
      deletedAt: null,
      email: { $not: /@deleted\.local$/i },
    };
    const filter: Record<string, unknown> = { ...activeUserFilter };

    if (query.search) {
      const escapedSearch = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { email: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    if (typeof query.isActive === "boolean") filter.isActive = query.isActive;
    if (query.accountType) filter.accountType = query.accountType;

    const [users, total, totalUsers, active, suspended, business] = await Promise.all([
      this.userRepository.findMany(filter, skip, limit),
      this.userRepository.count(filter),
      this.userRepository.count(activeUserFilter),
      this.userRepository.count({ ...activeUserFilter, isActive: true }),
      this.userRepository.count({ ...activeUserFilter, isActive: false }),
      this.userRepository.count({ ...activeUserFilter, accountType: "business" }),
    ]);
    const eventCounts = await this.eventRepository.countStatusesByUserIds(users.map((user) => user._id));
    const data = await Promise.all(users.map((user) => this.toAdminManagedUser(user, eventCounts.get(user._id.toString()))));

    return {
      data,
      meta: createPaginationMeta(page, limit, total),
      stats: { total: totalUsers, active, suspended, business },
    };
  }

  public async getForAdmin(id: string): Promise<AdminManagedUserResponse> {
    const user = await this.assertAdminManagedUser(id);
    const counts = await this.eventRepository.countStatusesByUserIds([user._id]);
    return this.toAdminManagedUser(user, counts.get(id));
  }

  public async updateForAdmin(
    id: string,
    payload: Pick<UpdateUserDto, "isActive" | "emailVerified">,
  ): Promise<AdminManagedUserResponse> {
    await this.assertAdminManagedUser(id);
    const user = await this.userRepository.updateById(id, payload);
    if (!user) throw new AppError("User not found", httpStatus.NOT_FOUND);
    const counts = await this.eventRepository.countStatusesByUserIds([user._id]);
    return this.toAdminManagedUser(user, counts.get(id));
  }

  public async deleteForAdmin(id: string): Promise<void> {
    await this.assertAdminManagedUser(id);
    const user = await this.userRepository.deactivateAccountById(id);
    if (!user) throw new AppError("User not found", httpStatus.NOT_FOUND);
  }

  public async getById(id: string, viewer?: AuthUser): Promise<UserResponse> {
    const user = await this.userRepository.findById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return this.toUserResponse(user, viewer);
  }

  public async listSuggestedUsers(user: AuthUser, limit = 10): Promise<SuggestedUserResponse[]> {
    const followingIds = await this.userFollowRepository.findFollowingIds(user.id);
    const users = await this.userRepository.findSuggestedUsers([user.id, ...followingIds], limit);

    return Promise.all(users.map((suggestedUser) => this.toSuggestedUserResponse(suggestedUser, false)));
  }

  public async listFriends(user: AuthUser, query: { search?: string; limit?: number }): Promise<FriendUserResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);
    const users = await this.userRepository.findFriendsByIds(friendIds, query.search, query.limit ?? 50);

    return Promise.all(users.map((friend) => this.toFriendUserResponse(friend)));
  }

  public async getProfileStats(targetUserId: string): Promise<UserProfileStatsResponse> {
    await this.assertFollowTarget(targetUserId);

    const [followers, following, reviews] = await Promise.all([
      this.userFollowRepository.countFollowers(targetUserId),
      this.userFollowRepository.countFollowing(targetUserId),
      this.eventHostReviewRepository.countByHostUserId(targetUserId),
    ]);

    return {
      reviews,
      followers,
      following,
    };
  }

  public async listFollowers(
    targetUserId: string,
    viewer: AuthUser,
    query: ListProfileUsersQuery,
  ): Promise<ProfileFollowUserResponse[]> {
    await this.assertFollowTarget(targetUserId);

    const limit = query.limit ?? 100;
    const followerIds = await this.userFollowRepository.findFollowerIds(targetUserId, limit);
    const users = await this.userRepository.findActiveUsersByIds(followerIds, query.search, limit);
    const viewerFollowingIds = new Set(await this.userFollowRepository.findFollowingIds(viewer.id));

    return Promise.all(users.map((profileUser) => this.toProfileFollowUserResponse(profileUser, viewerFollowingIds)));
  }

  public async listFollowing(
    targetUserId: string,
    viewer: AuthUser,
    query: ListProfileUsersQuery,
  ): Promise<ProfileFollowUserResponse[]> {
    await this.assertFollowTarget(targetUserId);

    const limit = query.limit ?? 100;
    const followingIds = await this.userFollowRepository.findFollowingIdsForList(targetUserId, limit);
    const users = await this.userRepository.findActiveUsersByIds(followingIds, query.search, limit);
    const viewerFollowingIds = new Set(await this.userFollowRepository.findFollowingIds(viewer.id));

    return Promise.all(users.map((profileUser) => this.toProfileFollowUserResponse(profileUser, viewerFollowingIds)));
  }

  public async listReviews(targetUserId: string): Promise<{ reviews: UserReviewResponse[]; count: number }> {
    await this.assertFollowTarget(targetUserId);
    const reviews = await this.eventHostReviewRepository.findByHostUserId(targetUserId);
    const reviewerIds = [...new Set(reviews.map((review) => review.reviewerUserId.toString()))];
    const eventIds = [...new Set(reviews.map((review) => review.eventId.toString()))];
    const [reviewers, events] = await Promise.all([
      this.userRepository.findByIds(reviewerIds),
      this.eventRepository.findManyByIds(eventIds),
    ]);
    const reviewerById = new Map(reviewers.map((reviewer) => [reviewer._id.toString(), reviewer]));
    const eventById = new Map(events.map((event) => [event._id.toString(), event]));
    const data = await Promise.all(
      reviews.map(async (review) => {
        const reviewer = reviewerById.get(review.reviewerUserId.toString()) ?? null;
        const event = eventById.get(review.eventId.toString()) ?? null;
        const avatarUrl = reviewer?.avatarKey
          ? await this.storageService.createDownloadUrl(reviewer.avatarKey).then((download) => download.url).catch(() => null)
          : null;

        return {
          id: review._id.toString(),
          author: reviewer
            ? {
                id: reviewer._id.toString(),
                name: reviewer.name,
                username: reviewer.username,
                avatarKey: reviewer.avatarKey ?? null,
                avatarUrl,
              }
            : null,
          text: review.text ?? "",
          liked: review.rating === "like",
          event: event
            ? {
                id: event._id.toString(),
                name: event.name ?? null,
              }
            : null,
          createdAt: review.createdAt,
        };
      }),
    );

    return {
      reviews: data,
      count: data.length,
    };
  }

  public async followUser(user: AuthUser, targetUserId: string): Promise<FollowStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot follow yourself", httpStatus.BAD_REQUEST);
    }

    const targetUser = await this.assertFollowTarget(targetUserId);
    await this.userFollowRepository.follow(user.id, targetUserId);

    void this.dispatchFollowNotification(user, targetUser);

    return {
      userId: targetUserId,
      isFollowing: true,
    };
  }

  private async dispatchFollowNotification(follower: AuthUser, targetUser: IUser): Promise<void> {
    try {
      const notification = await this.notificationRepository.create({
        recipientUserId: targetUser._id.toString(),
        type: "follow",
        actorUserId: follower.id,
        actorName: follower.name,
        actorUsername: follower.username,
        actorAvatarKey: follower.avatarKey ?? null,
      });

      realtimeGateway.notifyUser(targetUser._id.toString(), {
        type: "notification:new",
        notification: {
          id: notification._id.toString(),
          type: notification.type,
          actorId: follower.id,
          actorName: follower.name,
          actorUsername: follower.username ?? null,
          actorAvatarKey: follower.avatarKey ?? null,
          actorAvatarUrl: null,
          eventId: null,
          eventName: null,
          ticketName: null,
          isRead: false,
          createdAt: notification.createdAt.toISOString(),
        },
      });
    } catch {
      // Notification failure must not break the follow action
    }
  }

  public async unfollowUser(user: AuthUser, targetUserId: string): Promise<FollowStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot unfollow yourself", httpStatus.BAD_REQUEST);
    }

    await this.assertFollowTarget(targetUserId);
    await this.userFollowRepository.unfollow(user.id, targetUserId);

    return {
      userId: targetUserId,
      isFollowing: false,
    };
  }

  public async blockUser(user: AuthUser, targetUserId: string): Promise<BlockStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot block yourself", httpStatus.BAD_REQUEST);
    }

    await this.assertFollowTarget(targetUserId);
    await this.userBlockRepository.block(user.id, targetUserId);

    return { userId: targetUserId, isBlocked: true };
  }

  public async unblockUser(user: AuthUser, targetUserId: string): Promise<BlockStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot unblock yourself", httpStatus.BAD_REQUEST);
    }

    await this.userBlockRepository.unblock(user.id, targetUserId);

    return { userId: targetUserId, isBlocked: false };
  }

  public async getBlockedIds(userId: string): Promise<string[]> {
    return this.userBlockRepository.findBlockedIds(userId);
  }

  public async update(id: string, payload: UpdateUserDto): Promise<IUser> {
    if (payload.email) {
      const existingEmail = await this.userRepository.findByEmailExcludingId(payload.email, id);

      if (existingEmail) {
        throw new AppError("Email already exists", httpStatus.CONFLICT);
      }
    }

    if (payload.username) {
      const existingUsername = await this.userRepository.findByUsernameExcludingId(payload.username, id);

      if (existingUsername) {
        throw new AppError("Username already exists", httpStatus.CONFLICT);
      }
    }

    const updatePayload: UpdateUserDto = { ...payload };

    if (payload.currentLocationSharingEnabled === false) {
      updatePayload.currentLocation = null;
    } else if (payload.currentLocation) {
      updatePayload.currentLocation = {
        ...payload.currentLocation,
        updatedAt: new Date(),
      };
    }

    const user = await this.userRepository.updateById(id, updatePayload);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }

  public async delete(id: string): Promise<IUser> {
    const user = await this.userRepository.deactivateAccountById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }

  private async assertAdminManagedUser(id: string): Promise<IUser> {
    const user = await this.userRepository.findById(id);
    const isAnonymized = Boolean(user?.deletedAt) || user?.email.endsWith("@deleted.local");

    if (!user || user.role !== "user" || isAnonymized) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }

  private async toAdminManagedUser(
    user: IUser,
    eventCounts?: { total: number; completed: number; cancelled: number },
  ): Promise<AdminManagedUserResponse> {
    const avatarUrl = user.avatarKey
      ? await this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
      : null;

    return {
      id: user._id.toString(),
      name: user.name || "Deleted User",
      username: user.username,
      email: user.email || "Unavailable",
      contact: user.contact ?? null,
      accountType: user.accountType ?? "personal",
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      gender: user.gender ?? null,
      age: user.age ?? null,
      bio: user.bio ?? null,
      address: user.address ?? null,
      businessDocumentKey: user.businessDocumentKey ?? null,
      role: user.role,
      isActive: Boolean(user.isActive),
      emailVerified: Boolean(user.emailVerified),
      isDeleted: Boolean(user.deletedAt) || user.email.endsWith("@deleted.local"),
      totalEvents: eventCounts?.total ?? 0,
      completedEvents: eventCounts?.completed ?? 0,
      cancelledEvents: eventCounts?.cancelled ?? 0,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private async assertFollowTarget(targetUserId: string): Promise<IUser> {
    const targetUser = await this.userRepository.findById(targetUserId);

    if (!targetUser || !targetUser.isActive || targetUser.role !== "user") {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return targetUser;
  }

  private async toSuggestedUserResponse(user: IUser, isFollowing: boolean): Promise<SuggestedUserResponse> {
    const avatarUrl = user.avatarKey ? (await this.storageService.createDownloadUrl(user.avatarKey)).url : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      isFollowing,
    };
  }

  private async toFriendUserResponse(user: IUser): Promise<FriendUserResponse> {
    const avatarUrl = user.avatarKey ? (await this.storageService.createDownloadUrl(user.avatarKey)).url : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
    };
  }

  private async toProfileFollowUserResponse(
    user: IUser,
    viewerFollowingIds: Set<string>,
  ): Promise<ProfileFollowUserResponse> {
    const userId = user._id.toString();
    const avatarUrl = user.avatarKey ? (await this.storageService.createDownloadUrl(user.avatarKey)).url : null;

    return {
      id: userId,
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      isFollowing: viewerFollowingIds.has(userId),
    };
  }

  private async toUserResponse(user: IUser, viewer?: AuthUser): Promise<UserResponse> {
    const userId = user._id.toString();
    const [avatarUrl, isFollowing] = await Promise.all([
      user.avatarKey
        ? this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
        : Promise.resolve(null),
      viewer && viewer.id !== userId
        ? this.userFollowRepository.isFollowing(viewer.id, userId)
        : Promise.resolve(false),
    ]);

    return {
      id: userId,
      name: user.name,
      username: user.username,
      email: user.email,
      accountType: user.accountType ?? "personal",
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      bio: user.bio ?? null,
      ...(viewer && viewer.id !== userId ? { isFollowing } : {}),
    };
  }
}
