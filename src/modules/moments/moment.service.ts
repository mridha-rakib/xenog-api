import type { AuthUser } from "../auth/auth.interface.js";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { MomentShareRepository } from "./moment-share.repository.js";
import { MomentRepository } from "./moment.repository.js";
import type {
  CreateMomentCommentDto,
  CreateMomentDto,
  IMomentComment,
  IMoment,
  IMomentShare,
  MomentCommentAuthorResponse,
  MomentCommentResponse,
  MomentAuthorResponse,
  MomentInteractionSummaryResponse,
  MomentMediaItem,
  MomentResponse,
  MomentTimelineItemResponse,
} from "./moment.interface.js";
import { MomentCommentRepository } from "./moment-comment.repository.js";
import { MomentReactionRepository } from "./moment-reaction.repository.js";
import { EventRepository } from "../events/event.repository.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";

const MOMENT_ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

interface MomentInteractionContext {
  likeCounts: Map<string, number>;
  commentCounts: Map<string, number>;
  shareCounts: Map<string, number>;
  likedMomentIds: Set<string>;
}

export class MomentService {
  public constructor(
    private readonly momentRepository = new MomentRepository(),
    private readonly storageService = new StorageService(),
    private readonly userRepository = new UserRepository(),
    private readonly momentShareRepository = new MomentShareRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly momentReactionRepository = new MomentReactionRepository(),
    private readonly momentCommentRepository = new MomentCommentRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
  ) {}

  public async createMoment(payload: CreateMomentDto, user: AuthUser): Promise<MomentResponse> {
    let resolvedEventTitle = payload.eventTitle?.trim() || null;
    let resolvedEventId = payload.eventId?.trim() || null;

    if (resolvedEventId && payload.mode === "event") {
      const event = await this.eventRepository.findById(resolvedEventId);

      if (!event || event.status !== "published") {
        throw new AppError("Event not found or not available.", httpStatus.NOT_FOUND);
      }

      const isOrganizer = event.userId.toString() === user.id;

      if (!isOrganizer) {
        const now = Date.now();
        const scheduled = event.scheduledAt?.getTime() ?? null;
        const isLiveOrActive = scheduled !== null && scheduled <= now && now - scheduled <= MOMENT_ACTIVE_EVENT_WINDOW_MS;

        if (!isLiveOrActive) {
          throw new AppError("You can only post Mooments for events that are currently live or active.", httpStatus.FORBIDDEN);
        }

        const [hasPurchased, hasShared] = await Promise.all([
          this.checkoutPaymentRepository.hasUserPaidTicketForEvent(user.id, resolvedEventId),
          this.ticketShareRepository.hasActiveShareForRecipientAtEvent(user.id, resolvedEventId),
        ]);

        if (!hasPurchased && !hasShared) {
          throw new AppError("A valid ticket is required to post Mooments for this event.", httpStatus.FORBIDDEN);
        }
      }

      if (event.name) {
        resolvedEventTitle = event.name;
      }
    }

    const moment = await this.momentRepository.create({
      userId: user.id,
      mode: payload.mode,
      caption: payload.caption?.trim() || null,
      audience: payload.audience,
      taggedPeople: payload.taggedPeople ?? [],
      eventTitle: resolvedEventTitle,
      eventId: resolvedEventId,
      eventCode: payload.eventCode?.trim() || null,
      mediaItems: payload.mediaItems ?? [],
    });

    return this.toResponse(moment, undefined, user, new Set(), this.emptyInteractionContext());
  }

  public async listEventMoments(eventId: string, user: AuthUser): Promise<MomentResponse[]> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status !== "published") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const moments = await this.momentRepository.findByEventId(eventId);
    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);

    return Promise.all(
      moments.map((moment) => this.toResponse(moment, undefined, user, viewerFollowingIds, interactionContext)),
    );
  }

  public async listMyMoments(user: AuthUser): Promise<MomentResponse[]> {
    const moments = await this.momentRepository.findByUserId(user.id);
    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);

    return Promise.all(
      moments.map((moment) => this.toResponse(moment, undefined, user, viewerFollowingIds, interactionContext)),
    );
  }

  public async listFeedMoments(user: AuthUser): Promise<MomentResponse[]> {
    const moments = await this.momentRepository.findFeed();
    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);

    return Promise.all(
      moments.map((moment) => this.toResponse(moment, undefined, user, viewerFollowingIds, interactionContext)),
    );
  }

  public async shareMoment(momentId: string, user: AuthUser): Promise<MomentTimelineItemResponse> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.userId.toString() === user.id) {
      throw new AppError("Your own posts already appear on your timeline", httpStatus.BAD_REQUEST);
    }

    if (moment.audience !== "public") {
      throw new AppError("Only public posts can be shared", httpStatus.BAD_REQUEST);
    }

    const share = await this.momentShareRepository.share(user.id, momentId);

    const interactionContext = await this.buildInteractionContext([moment], user);

    return {
      id: share._id.toString(),
      type: "share",
      createdAt: share.createdAt,
      sharedAt: share.createdAt,
      moment: await this.toResponse(
        moment,
        undefined,
        user,
        await this.getViewerFollowingIdSet(user),
        interactionContext,
      ),
    };
  }

  public async toggleMomentReaction(momentId: string, user: AuthUser): Promise<MomentInteractionSummaryResponse> {
    await this.getViewableMoment(momentId, user);
    await this.momentReactionRepository.toggleLike(user.id, momentId);

    return this.getInteractionSummary(momentId, user);
  }

  public async deleteMoment(momentId: string, user: AuthUser): Promise<void> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.userId.toString() !== user.id) {
      throw new AppError("You can only delete your own posts", httpStatus.FORBIDDEN);
    }

    const deletedMoment = await this.momentRepository.deleteByIdForUser(momentId, user.id);

    if (!deletedMoment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    await Promise.all([
      this.momentReactionRepository.deleteByMomentId(momentId),
      this.momentCommentRepository.deleteByMomentId(momentId),
      this.momentShareRepository.deleteByMomentId(momentId),
    ]);
  }

  public async listMomentComments(momentId: string, user: AuthUser): Promise<MomentCommentResponse[]> {
    await this.getViewableMoment(momentId, user);
    const comments = await this.momentCommentRepository.findByMomentId(momentId);

    return this.toCommentTreeResponse(comments);
  }

  public async createMomentComment(
    momentId: string,
    payload: CreateMomentCommentDto,
    user: AuthUser,
  ): Promise<{ comment: MomentCommentResponse; summary: MomentInteractionSummaryResponse }> {
    await this.getViewableMoment(momentId, user);

    if (payload.parentCommentId) {
      const parentComment = await this.momentCommentRepository.findById(payload.parentCommentId);

      if (!parentComment || parentComment.momentId.toString() !== momentId) {
        throw new AppError("Parent comment not found", httpStatus.NOT_FOUND);
      }
    }

    const comment = await this.momentCommentRepository.create({
      momentId,
      userId: user.id,
      parentCommentId: payload.parentCommentId ?? null,
      text: payload.text.trim(),
    });

    return {
      comment: await this.toCommentResponse(comment, []),
      summary: await this.getInteractionSummary(momentId, user),
    };
  }

  public async getProfileTimeline(targetUserId: string, viewer?: AuthUser): Promise<{
    items: MomentTimelineItemResponse[];
    stats: { posts: number };
  }> {
    const includePrivate = Boolean(viewer?.id && viewer.id === targetUserId);
    const targetUser = await this.userRepository.findById(targetUserId);

    if (!targetUser || !targetUser.isActive || targetUser.role !== "user") {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    const [authoredMoments, shares, authoredCount, shareCount] = await Promise.all([
      this.momentRepository.findByUserIdForProfile(targetUserId, includePrivate),
      this.momentShareRepository.findByUserId(targetUserId),
      this.momentRepository.countByUserId(targetUserId, includePrivate),
      this.momentShareRepository.countByUserId(targetUserId),
    ]);
    const sharedMomentIds = shares.map((share) => share.momentId.toString());
    const sharedMoments = await this.momentRepository.findByIds(sharedMomentIds);
    const interactionMoments = [...authoredMoments, ...sharedMoments];
    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(viewer),
      this.buildInteractionContext(interactionMoments, viewer),
    ]);
    const sharedMomentById = new Map(sharedMoments.map((moment) => [moment._id.toString(), moment]));
    const authoredItems = await Promise.all(
      authoredMoments.map(async (moment) => ({
        id: moment._id.toString(),
        type: "post" as const,
        createdAt: moment.createdAt,
        sharedAt: null,
        moment: await this.toResponse(moment, targetUser, viewer, viewerFollowingIds, interactionContext),
      })),
    );
    const sharedItems = await Promise.all(
      shares
        .map((share) => {
          const moment = sharedMomentById.get(share.momentId.toString());

          if (!moment || (!includePrivate && moment.audience !== "public")) {
            return null;
          }

          return { share, moment };
        })
        .filter((item): item is { share: IMomentShare; moment: IMoment } => Boolean(item))
        .map(async ({ share, moment }) => ({
          id: share._id.toString(),
          type: "share" as const,
          createdAt: share.createdAt,
          sharedAt: share.createdAt,
          moment: await this.toResponse(moment, undefined, viewer, viewerFollowingIds, interactionContext),
        })),
    );

    return {
      items: [...authoredItems, ...sharedItems].sort(
        (firstItem, secondItem) => secondItem.createdAt.getTime() - firstItem.createdAt.getTime(),
      ),
      stats: {
        posts: authoredCount + shareCount,
      },
    };
  }

  private async toResponse(
    moment: IMoment,
    author?: IUser | null,
    viewer?: AuthUser,
    viewerFollowingIds = new Set<string>(),
    interactionContext?: MomentInteractionContext,
  ): Promise<MomentResponse> {
    const momentId = moment._id.toString();
    const [mediaItems, resolvedAuthor, interactionSummary] = await Promise.all([
      Promise.all(moment.mediaItems.map((mediaItem) => this.toMediaResponse(mediaItem))),
      author === undefined ? this.userRepository.findById(moment.userId.toString()) : Promise.resolve(author),
      interactionContext
        ? Promise.resolve(this.getInteractionSummaryFromContext(momentId, interactionContext))
        : this.getInteractionSummary(momentId, viewer),
    ]);

    return {
      id: momentId,
      userId: moment.userId.toString(),
      author: await this.toAuthorResponse(resolvedAuthor, viewer, viewerFollowingIds),
      mode: moment.mode,
      caption: moment.caption ?? null,
      audience: moment.audience,
      taggedPeople: moment.taggedPeople,
      eventTitle: moment.eventTitle ?? null,
      eventId: moment.eventId?.toString() ?? null,
      eventCode: moment.eventCode ?? null,
      mediaItems,
      likesCount: interactionSummary.likesCount,
      commentsCount: interactionSummary.commentsCount,
      sharesCount: interactionSummary.sharesCount,
      isLiked: interactionSummary.isLiked,
      createdAt: moment.createdAt,
      updatedAt: moment.updatedAt,
    };
  }

  private async toMediaResponse(mediaItem: MomentMediaItem): Promise<MomentMediaItem> {
    const plainMediaItem = typeof (mediaItem as unknown as { toObject?: () => MomentMediaItem }).toObject === "function"
      ? (mediaItem as unknown as { toObject: () => MomentMediaItem }).toObject()
      : mediaItem;

    if (plainMediaItem.url || !plainMediaItem.storageKey) {
      return plainMediaItem;
    }

    try {
      const download = await this.storageService.createDownloadUrl(plainMediaItem.storageKey);

      return {
        ...plainMediaItem,
        url: download.url,
      };
    } catch {
      return plainMediaItem;
    }
  }

  private async toAuthorResponse(
    user: IUser | null,
    viewer?: AuthUser,
    viewerFollowingIds = new Set<string>(),
  ): Promise<MomentAuthorResponse | null> {
    if (!user) {
      return null;
    }

    const userId = user._id.toString();
    let avatarUrl: string | null = null;

    if (user.avatarKey) {
      try {
        const download = await this.storageService.createDownloadUrl(user.avatarKey);
        avatarUrl = download.url;
      } catch {
        avatarUrl = null;
      }
    }

    return {
      id: userId,
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      isFollowing: Boolean(viewer && viewer.id !== userId && viewerFollowingIds.has(userId)),
    };
  }

  private async toCommentTreeResponse(comments: IMomentComment[]): Promise<MomentCommentResponse[]> {
    const commentsByParentId = new Map<string, IMomentComment[]>();

    comments.forEach((comment) => {
      const parentId = comment.parentCommentId?.toString() ?? "root";
      const parentComments = commentsByParentId.get(parentId) ?? [];

      parentComments.push(comment);
      commentsByParentId.set(parentId, parentComments);
    });

    const buildTree = async (comment: IMomentComment): Promise<MomentCommentResponse> => {
      const replies = commentsByParentId.get(comment._id.toString()) ?? [];

      return this.toCommentResponse(comment, await Promise.all(replies.map(buildTree)));
    };

    return Promise.all((commentsByParentId.get("root") ?? []).map(buildTree));
  }

  private async toCommentResponse(comment: IMomentComment, replies: MomentCommentResponse[]): Promise<MomentCommentResponse> {
    const author = await this.userRepository.findById(comment.userId.toString());

    return {
      id: comment._id.toString(),
      momentId: comment.momentId.toString(),
      parentCommentId: comment.parentCommentId?.toString() ?? null,
      author: await this.toCommentAuthorResponse(author),
      text: comment.text,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      replies,
    };
  }

  private async toCommentAuthorResponse(user: IUser | null): Promise<MomentCommentAuthorResponse | null> {
    if (!user) {
      return null;
    }

    let avatarUrl: string | null = null;

    if (user.avatarKey) {
      try {
        const download = await this.storageService.createDownloadUrl(user.avatarKey);
        avatarUrl = download.url;
      } catch {
        avatarUrl = null;
      }
    }

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
    };
  }

  private async getViewableMoment(momentId: string, viewer: AuthUser): Promise<IMoment> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.audience !== "public" && moment.userId.toString() !== viewer.id) {
      throw new AppError("You do not have access to this moment", httpStatus.FORBIDDEN);
    }

    return moment;
  }

  private async getInteractionSummary(momentId: string, viewer?: AuthUser): Promise<MomentInteractionSummaryResponse> {
    const [likesCount, commentsCount, sharesCount, likedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentId(momentId),
      this.momentCommentRepository.countByMomentId(momentId),
      this.momentShareRepository.countByMomentId(momentId),
      viewer ? this.momentReactionRepository.findLikedMomentIds(viewer.id, [momentId]) : Promise.resolve(new Set<string>()),
    ]);

    return {
      momentId,
      likesCount,
      commentsCount,
      sharesCount,
      isLiked: likedMomentIds.has(momentId),
    };
  }

  private getInteractionSummaryFromContext(
    momentId: string,
    interactionContext: MomentInteractionContext,
  ): MomentInteractionSummaryResponse {
    return {
      momentId,
      likesCount: interactionContext.likeCounts.get(momentId) ?? 0,
      commentsCount: interactionContext.commentCounts.get(momentId) ?? 0,
      sharesCount: interactionContext.shareCounts.get(momentId) ?? 0,
      isLiked: interactionContext.likedMomentIds.has(momentId),
    };
  }

  private async buildInteractionContext(moments: IMoment[], viewer?: AuthUser): Promise<MomentInteractionContext> {
    const momentIds = [...new Set(moments.map((moment) => moment._id.toString()))];
    const [likeCounts, commentCounts, shareCounts, likedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentIds(momentIds),
      this.momentCommentRepository.countByMomentIds(momentIds),
      this.momentShareRepository.countByMomentIds(momentIds),
      viewer ? this.momentReactionRepository.findLikedMomentIds(viewer.id, momentIds) : Promise.resolve(new Set<string>()),
    ]);

    return {
      likeCounts,
      commentCounts,
      shareCounts,
      likedMomentIds,
    };
  }

  private emptyInteractionContext(): MomentInteractionContext {
    return {
      likeCounts: new Map(),
      commentCounts: new Map(),
      shareCounts: new Map(),
      likedMomentIds: new Set(),
    };
  }

  private async getViewerFollowingIdSet(viewer?: AuthUser): Promise<Set<string>> {
    if (!viewer?.id) {
      return new Set();
    }

    return new Set(await this.userFollowRepository.findFollowingIds(viewer.id));
  }
}
