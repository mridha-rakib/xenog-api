import httpStatus from "http-status";
import bcrypt from "bcryptjs";
import { AppError } from "../../core/errors/app-error.js";
import {
  createPaginationMeta,
  getPaginationOptions,
  type PaginatedResult,
} from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type {
  CreateUserDto,
  FollowStatusResponse,
  FriendUserResponse,
  IUser,
  ProfileFollowUserResponse,
  SuggestedUserResponse,
  UpdateUserDto,
  UserProfileStatsResponse,
  UserReviewResponse,
} from "./user.interface.js";
import { UserFollowRepository } from "./user-follow.repository.js";
import { UserRepository } from "./user.repository.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { realtimeGateway } from "../realtime/realtime.gateway.js";

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

export class UserService {
  public constructor(
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly notificationRepository = new NotificationRepository(),
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

  public async getById(id: string): Promise<IUser> {
    const user = await this.userRepository.findById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
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

    const [followers, following] = await Promise.all([
      this.userFollowRepository.countFollowers(targetUserId),
      this.userFollowRepository.countFollowing(targetUserId),
    ]);

    return {
      reviews: 0,
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

    return {
      reviews: [],
      count: 0,
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
    const user = await this.userRepository.deleteById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
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
}
