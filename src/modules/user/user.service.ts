import httpStatus from "http-status";
import bcrypt from "bcryptjs";
import { AppError } from "../../core/errors/app-error.js";
import {
  createPaginationMeta,
  getPaginationOptions,
  type PaginatedResult,
} from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { IEvent } from "../events/event.interface.js";
import { EventRepository } from "../events/event.repository.js";
import {
  DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
  type EventWindowMediaItem,
  type EventWindowPostMediaResponse,
  type IEventWindow,
  type IEventWindowPost,
} from "../event-windows/event-window.interface.js";
import { EventWindowRepository } from "../event-windows/event-window.repository.js";
import { StorageService } from "../storage/storage.service.js";
import type {
  AdminManagedUserResponse,
  AdminUserStatsResponse,
  BlockedUserResponse,
  BlockStatusResponse,
  CreateUserDto,
  FollowStatusResponse,
  FriendUserResponse,
  IUser,
  ProfileFollowUserResponse,
  ProfileWindowPostAuthorResponse,
  ProfileWindowEventSummary,
  ProfileWindowPostResponse,
  SuggestedUserResponse,
  UpdateUserDto,
  UserProfileStatsResponse,
  UserResponse,
  UserReviewResponse,
} from "./user.interface.js";
import { UserFollowRepository } from "./user-follow.repository.js";
import { UserBlockRepository } from "./user-block.repository.js";
import { getBlockRelationship, isUserPubliclyViewable } from "./user-access.js";
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
  page?: number;
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
    private readonly eventWindowRepository = new EventWindowRepository(),
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
    const [followingIds, blockedIds, blockerIds] = await Promise.all([
      this.userFollowRepository.findFollowingIds(user.id),
      this.userBlockRepository.findBlockedIds(user.id),
      this.userBlockRepository.findBlockerIds(user.id),
    ]);
    const excludedIds = [...new Set([user.id, ...followingIds, ...blockedIds, ...blockerIds])];
    const users = await this.userRepository.findSuggestedUsers(excludedIds, limit);

    return Promise.all(users.map((suggestedUser) => this.toSuggestedUserResponse(suggestedUser, false)));
  }

  public async listFriends(user: AuthUser, query: { search?: string; limit?: number }): Promise<FriendUserResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);
    const users = await this.userRepository.findFriendsByIds(friendIds, query.search, query.limit ?? 50);

    return Promise.all(users.map((friend) => this.toFriendUserResponse(friend)));
  }

  public async getProfileStats(targetUserId: string, viewer: AuthUser): Promise<UserProfileStatsResponse> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);

    const [followers, following, reviews, windows] = await Promise.all([
      this.userFollowRepository.countFollowers(targetUserId),
      this.userFollowRepository.countFollowing(targetUserId),
      this.eventHostReviewRepository.countByHostUserId(targetUserId),
      this.eventWindowRepository.countDistinctAcceptedWindowsByUser(targetUserId),
    ]);

    return {
      reviews,
      followers,
      following,
      windows,
    };
  }

  public async listProfileWindowEvents(
    targetUserId: string,
    viewer: AuthUser,
    query: { page?: number; limit?: number },
  ): Promise<{
    events: ProfileWindowEventSummary[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);

    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 20 });
    const [groups, total] = await Promise.all([
      this.eventWindowRepository.listAcceptedPostEventGroupsByUser(targetUserId, skip, limit),
      this.eventWindowRepository.countAcceptedPostEventGroupsByUser(targetUserId),
    ]);
    const events = await this.eventRepository.findByIds(groups.map((group) => group.eventId.toString()));
    const eventsById = new Map(events.map((event) => [event._id.toString(), event]));
    const summaries: ProfileWindowEventSummary[] = [];

    for (const group of groups) {
      const event = eventsById.get(group.eventId.toString());
      if (!event || !this.canAccessEventForProfileWindows(viewer, event)) {
        continue;
      }

      summaries.push({
        id: event._id.toString(),
        name: event.name ?? "",
        bannerImageKey: event.bannerImageKey ?? null,
        bannerImageDisplay: event.bannerImageDisplay ?? null,
        scheduledAt: event.scheduledAt ?? null,
        endAt: event.endAt ?? null,
        status: event.status,
        windowCount: group.windowCount,
        lastParticipatedAt: group.lastParticipatedAt,
      });
    }

    return {
      events: summaries,
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  public async listProfileWindowPosts(
    targetUserId: string,
    eventId: string,
    viewer: AuthUser,
    query: { page?: number; limit?: number },
  ): Promise<{
    posts: ProfileWindowPostResponse[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);

    const event = await this.eventRepository.findById(eventId);
    if (!event || !this.canAccessEventForProfileWindows(viewer, event)) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 20 });
    const [posts, total, targetUser] = await Promise.all([
      this.eventWindowRepository.listAcceptedPostsByUserForEvent(targetUserId, eventId, skip, limit),
      this.eventWindowRepository.countAcceptedPostsByUserForEvent(targetUserId, eventId),
      this.userRepository.findById(targetUserId),
    ]);
    const windows = await this.eventWindowRepository.findByIds(posts.map((post) => post.windowId.toString()));
    const windowsById = new Map(windows.map((window) => [window._id.toString(), window]));
    const visiblePosts: ProfileWindowPostResponse[] = [];
    const author = await this.toProfileWindowPostAuthorResponse(targetUser);

    for (const post of posts) {
      const window = windowsById.get(post.windowId.toString());
      if (!window || !(await this.canViewProfileWindowPost(viewer, event, window))) {
        continue;
      }

      visiblePosts.push({
        id: post._id.toString(),
        eventId: post.eventId.toString(),
        windowId: post.windowId.toString(),
        userId: post.userId.toString(),
        author,
        contentType: post.contentType,
        text: post.text ?? null,
        mediaItems: post.mediaItems.map((mediaItem, index) => this.toProfileWindowPostMediaResponse(post, mediaItem, index)),
        status: post.status,
        window: {
          id: window._id.toString(),
          title: window.title ?? null,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        },
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
      });
    }

    return {
      posts: visiblePosts,
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  public async listFollowers(
    targetUserId: string,
    viewer: AuthUser,
    query: ListProfileUsersQuery,
  ): Promise<{
    users: ProfileFollowUserResponse[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);

    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 100 });
    const [followerIds, total] = await Promise.all([
      this.userFollowRepository.findFollowerIds(targetUserId, limit, skip),
      this.userFollowRepository.countFollowers(targetUserId),
    ]);
    const users = await this.userRepository.findActiveUsersByIds(followerIds, query.search, limit);
    const viewerFollowingIds = new Set(await this.userFollowRepository.findFollowingIds(viewer.id));

    return {
      users: await Promise.all(users.map((profileUser) => this.toProfileFollowUserResponse(profileUser, viewerFollowingIds))),
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  public async listFollowing(
    targetUserId: string,
    viewer: AuthUser,
    query: ListProfileUsersQuery,
  ): Promise<{
    users: ProfileFollowUserResponse[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);

    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 100 });
    const [followingIds, total] = await Promise.all([
      this.userFollowRepository.findFollowingIdsForList(targetUserId, limit, skip),
      this.userFollowRepository.countFollowing(targetUserId),
    ]);
    const users = await this.userRepository.findActiveUsersByIds(followingIds, query.search, limit);
    const viewerFollowingIds = new Set(await this.userFollowRepository.findFollowingIds(viewer.id));

    return {
      users: await Promise.all(users.map((profileUser) => this.toProfileFollowUserResponse(profileUser, viewerFollowingIds))),
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  public async listReviews(
    targetUserId: string,
    viewer: AuthUser,
    query: { page?: number; limit?: number } = {},
  ): Promise<{
    reviews: UserReviewResponse[];
    count: number;
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(viewer, targetUserId);
    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 100 });
    const [reviews, total] = await Promise.all([
      this.eventHostReviewRepository.findByHostUserId(targetUserId, limit, skip),
      this.eventHostReviewRepository.countByHostUserId(targetUserId),
    ]);
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
      count: total,
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  public async followUser(user: AuthUser, targetUserId: string): Promise<FollowStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot follow yourself", httpStatus.BAD_REQUEST);
    }

    const targetUser = await this.assertFollowTarget(targetUserId);
    await this.assertProfileAccessible(user, targetUserId);
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
    await this.userFollowRepository.removeBetween(user.id, targetUserId);

    return { userId: targetUserId, isBlocked: true };
  }

  public async unblockUser(user: AuthUser, targetUserId: string): Promise<BlockStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot unblock yourself", httpStatus.BAD_REQUEST);
    }

    await this.userBlockRepository.unblock(user.id, targetUserId);

    return { userId: targetUserId, isBlocked: false };
  }

  public async listBlockedUsers(
    user: AuthUser,
    query: { page?: number; limit?: number },
  ): Promise<PaginatedResult<BlockedUserResponse>> {
    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 30 });
    const result = await this.userBlockRepository.findBlockedUsers(user.id, skip, limit);

    return {
      data: await Promise.all(result.users.map((blockedUser) => this.toBlockedUserResponse(blockedUser))),
      meta: createPaginationMeta(page, limit, result.total),
    };
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

  private async getBlockRelationship(viewerId: string, targetUserId: string): Promise<{
    viewerHasBlockedTarget: boolean;
    targetHasBlockedViewer: boolean;
  }> {
    // Delegates to the shared helper so profile / moment / story surfaces all
    // read block state the same way. Behaviour is unchanged.
    return getBlockRelationship(this.userBlockRepository, viewerId, targetUserId);
  }

  private async assertProfileAccessible(viewer: AuthUser, targetUserId: string): Promise<void> {
    if (viewer.id === targetUserId) {
      return;
    }

    const relationship = await this.getBlockRelationship(viewer.id, targetUserId);

    if (relationship.viewerHasBlockedTarget || relationship.targetHasBlockedViewer) {
      throw new AppError("Profile unavailable", httpStatus.FORBIDDEN);
    }
  }

  private canAccessEventForProfileWindows(viewer: AuthUser, event: IEvent): boolean {
    if (viewer.role === "admin" || event.userId.toString() === viewer.id) {
      return true;
    }

    if (event.status === "draft") {
      return false;
    }

    if (event.status !== "published" && event.status !== "live" && event.status !== "completed") {
      return false;
    }

    if (event.privacy === "private" && !event.memberUserIds.some((id) => id.toString() === viewer.id)) {
      return false;
    }

    return true;
  }

  private hasEventEnded(event: IEvent): boolean {
    return event.status === "completed";
  }

  private resolveParticipantPostVisibility(window: IEventWindow) {
    return window.participantPostVisibility ?? DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY;
  }

  private async canViewProfileWindowPost(viewer: AuthUser, event: IEvent, window: IEventWindow): Promise<boolean> {
    if (viewer.role === "admin" || event.userId.toString() === viewer.id) {
      return true;
    }

    const viewerPost = await this.eventWindowRepository.findAcceptedPostByUser(window._id.toString(), viewer.id);
    if (!viewerPost) {
      return false;
    }

    return this.resolveParticipantPostVisibility(window) === "instant" || this.hasEventEnded(event);
  }

  private toProfileWindowPostMediaResponse(
    post: IEventWindowPost,
    mediaItem: EventWindowMediaItem,
    index: number,
  ): EventWindowPostMediaResponse {
    const base = {
      type: mediaItem.type,
      source: mediaItem.source,
      contentType: mediaItem.contentType ?? null,
      durationSeconds: mediaItem.durationSeconds ?? null,
    };

    if (!mediaItem.storageKey) {
      return base;
    }

    return {
      ...base,
      url: `/events/${post.eventId.toString()}/windows/${post.windowId.toString()}/posts/${post._id.toString()}/media/${index}`,
    };
  }

  private async toProfileWindowPostAuthorResponse(user: IUser | null): Promise<ProfileWindowPostAuthorResponse | null> {
    if (!user) {
      return null;
    }

    const avatarUrl = user.avatarKey
      ? await this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
      : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
    };
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

  private async toBlockedUserResponse(
    user: Pick<IUser, "_id" | "name" | "username" | "avatarKey"> & { blockedAt: Date },
  ): Promise<BlockedUserResponse> {
    const avatarUrl = user.avatarKey
      ? await this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
      : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      blockedAt: user.blockedAt,
    };
  }

  private async toUserResponse(user: IUser, viewer?: AuthUser): Promise<UserResponse> {
    const userId = user._id.toString();
    const [avatarUrl, relationship] = await Promise.all([
      user.avatarKey
        ? this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
        : Promise.resolve(null),
      viewer && viewer.id !== userId
        ? this.getBlockRelationship(viewer.id, userId)
        : Promise.resolve({ viewerHasBlockedTarget: false, targetHasBlockedViewer: false }),
    ]);
    const isBlockedProfile = relationship.viewerHasBlockedTarget || relationship.targetHasBlockedViewer;
    const isSelf = Boolean(viewer && viewer.id === userId);

    // Suspended / banned / deleted / non-user accounts must never expose
    // private profile fields (email, bio, accountType, follow state) to
    // anyone but the account itself. Return a safe, minimal "unavailable"
    // shape instead. The owner viewing their own profile is unaffected.
    if (!isSelf && !isUserPubliclyViewable(user)) {
      return {
        id: userId,
        name: "Unavailable",
        username: null,
        avatarKey: null,
        avatarUrl: null,
        profileAccess: "unavailable",
      };
    }

    if (isBlockedProfile) {
      return {
        id: userId,
        name: user.name,
        username: user.username,
        avatarKey: user.avatarKey ?? null,
        avatarUrl,
        profileAccess: "blocked",
        viewerHasBlockedTarget: relationship.viewerHasBlockedTarget,
        targetHasBlockedViewer: relationship.targetHasBlockedViewer,
        blockedTitle: relationship.viewerHasBlockedTarget ? "You blocked this account" : "This account isn't available",
        blockedDescription: relationship.viewerHasBlockedTarget
          ? "Unblock to view this profile, posts, and interact again."
          : "You can't view this profile or interact with this account.",
      };
    }

    const isFollowing = viewer && viewer.id !== userId
      ? await this.userFollowRepository.isFollowing(viewer.id, userId)
      : false;

    return {
      id: userId,
      name: user.name,
      username: user.username,
      email: user.email,
      accountType: user.accountType ?? "personal",
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      bio: user.bio ?? null,
      profileAccess: "open",
      viewerHasBlockedTarget: relationship.viewerHasBlockedTarget,
      targetHasBlockedViewer: relationship.targetHasBlockedViewer,
      ...(viewer && viewer.id !== userId ? { isFollowing } : {}),
    };
  }
}
