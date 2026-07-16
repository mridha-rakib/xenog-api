import type { AuthUser } from "../auth/auth.interface.js";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { createPaginationMeta, getPaginationOptions } from "../../core/utils/pagination.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { MomentShareRepository } from "./moment-share.repository.js";
import { MomentRepository } from "./moment.repository.js";
import type {
  CreateMomentCommentDto,
  CreateMomentDto,
  CreateMomentShareDto,
  IMomentComment,
  IMoment,
  IMomentShare,
  MomentCommentAuthorResponse,
  MomentCommentResponse,
  MomentAuthorResponse,
  MomentInteractionSummaryResponse,
  MomentMediaItem,
  MomentResponse,
  MomentFeedQuery,
  ProfileTimelineQuery,
  MomentSaveSummaryResponse,
  MomentTimelineItemResponse,
} from "./moment.interface.js";
import { extractHashtags, normalizeHashtag } from "./moment-hashtag.js";
import { MomentCommentRepository } from "./moment-comment.repository.js";
import { MomentCommentReactionRepository } from "./moment-comment-reaction.repository.js";
import { MomentReactionRepository } from "./moment-reaction.repository.js";
import { MomentSaveRepository } from "./moment-save.repository.js";
import { EventRepository } from "../events/event.repository.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";

const MOMENT_ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

interface MomentInteractionContext {
  likeCounts: Map<string, number>;
  commentCounts: Map<string, number>;
  shareCounts: Map<string, number>;
  likedMomentIds: Set<string>;
  savedMomentIds: Set<string>;
}

export class MomentService {
  public constructor(
    private readonly momentRepository = new MomentRepository(),
    private readonly storageService = new StorageService(),
    private readonly userRepository = new UserRepository(),
    private readonly momentShareRepository = new MomentShareRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly userBlockRepository = new UserBlockRepository(),
    private readonly momentReactionRepository = new MomentReactionRepository(),
    private readonly momentCommentRepository = new MomentCommentRepository(),
    private readonly momentCommentReactionRepository = new MomentCommentReactionRepository(),
    private readonly momentSaveRepository = new MomentSaveRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
  ) {}

  public async createMoment(payload: CreateMomentDto, user: AuthUser): Promise<MomentResponse> {
    let resolvedEventTitle = payload.eventTitle?.trim() || null;
    const resolvedEventId = payload.eventId?.trim() || null;

    if (resolvedEventId) {
      const event = await this.eventRepository.findById(resolvedEventId);

      if (!event || event.status !== "published") {
        throw new AppError("Event not found or not available.", httpStatus.NOT_FOUND);
      }

      if (!this.isPostTaggableEvent(event)) {
        throw new AppError("You can only tag upcoming, live, or active events.", httpStatus.FORBIDDEN);
      }

      if (event.privacy === "private" && event.userId.toString() !== user.id) {
        const [hasPurchased, hasShared] = await Promise.all([
          this.checkoutPaymentRepository.hasUserPaidTicketForEvent(user.id, resolvedEventId),
          this.ticketShareRepository.hasActiveShareForRecipientAtEvent(user.id, resolvedEventId),
        ]);

        if (!hasPurchased && !hasShared) {
          throw new AppError("A valid ticket is required to tag this event.", httpStatus.FORBIDDEN);
        }
      }

      if (event.name) {
        resolvedEventTitle = event.name;
      }
    }

    const taggedFriendIds = [...new Set(payload.taggedFriendIds ?? [])];
    let taggedPeople = payload.taggedPeople ?? [];

    if (taggedFriendIds.length > 0) {
      const taggedUsers = await this.userRepository.findByIds(taggedFriendIds);
      const taggedUserById = new Map(taggedUsers
        .filter((taggedUser) => taggedUser.isActive && taggedUser.role === "user")
        .map((taggedUser) => [taggedUser._id.toString(), taggedUser]));

      if (taggedFriendIds.some((id) => !taggedUserById.has(id))) {
        throw new AppError("Tagged users not found.", httpStatus.BAD_REQUEST);
      }

      if (taggedPeople.length === 0) {
        taggedPeople = taggedFriendIds.map((id) => taggedUserById.get(id)?.name).filter(Boolean) as string[];
      }
    }

    const moment = await this.momentRepository.create({
      userId: user.id,
      mode: payload.mode,
      caption: payload.caption?.trim() || null,
      hashtags: extractHashtags(payload.caption),
      audience: payload.audience,
      taggedPeople,
      taggedFriendIds,
      eventTitle: resolvedEventTitle,
      eventId: resolvedEventId,
      eventCode: payload.eventCode?.trim() || null,
      mediaItems: payload.mediaItems ?? [],
    });

    return this.toResponse(moment, undefined, user, new Set(), this.emptyInteractionContext());
  }

  private isPostTaggableEvent(event: { scheduledAt?: Date | null; endAt?: Date | null }): boolean {
    const now = Date.now();
    const scheduled = event.scheduledAt?.getTime() ?? null;
    const ended = event.endAt?.getTime() ?? null;

    if (ended !== null) {
      return ended >= now;
    }

    return scheduled === null || scheduled >= now - MOMENT_ACTIVE_EVENT_WINDOW_MS;
  }

  public async listEventMoments(eventId: string, user: AuthUser): Promise<MomentResponse[]> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status !== "published") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const moments = await this.momentRepository.findByEventId(eventId);
    const uniqueUserIds = [...new Set(moments.map((m) => m.userId.toString()))];
    const [authors, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findByIds(uniqueUserIds),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));

    return Promise.all(
      moments.map((moment) => this.toResponse(
        moment,
        authorById.get(moment.userId.toString()) ?? null,
        user,
        viewerFollowingIds,
        interactionContext,
      )),
    );
  }

  public async listMyMoments(user: AuthUser): Promise<MomentResponse[]> {
    const moments = await this.momentRepository.findByUserId(user.id);
    const [userDoc, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findById(user.id),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);

    return Promise.all(
      moments.map((moment) => this.toResponse(moment, userDoc, user, viewerFollowingIds, interactionContext)),
    );
  }

  public async listFeedMoments(user: AuthUser, query: MomentFeedQuery = {}): Promise<MomentResponse[]> {
    const hashtags = query.hashtags?.map(normalizeHashtag).filter(Boolean);
    const excludeUserIds = await this.userBlockRepository.findBlockedIds(user.id);
    const candidateEventIds = await this.momentRepository.findFeedCandidateEventIds({ ...query, hashtags, excludeUserIds });
    const visibleEvents = await this.eventRepository.findFeedVisibleByIdsForUser(
      candidateEventIds,
      user.id,
      excludeUserIds,
    );
    const visibleEventIds = visibleEvents.map((event) => event._id.toString());
    const moments = await this.momentRepository.findFeed({
      ...query,
      hashtags,
      excludeUserIds,
      visibleEventIds,
    });
    const uniqueUserIds = [...new Set(moments.map((m) => m.userId.toString()))];
    const [authors, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findByIds(uniqueUserIds),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));

    return Promise.all(
      moments.map((moment) => this.toResponse(
        moment,
        authorById.get(moment.userId.toString()) ?? null,
        user,
        viewerFollowingIds,
        interactionContext,
      )),
    );
  }

  public async listHashtagMoments(hashtagValue: string, user: AuthUser, limit = 100): Promise<MomentResponse[]> {
    const hashtag = normalizeHashtag(hashtagValue);
    const moments = hashtag ? await this.momentRepository.findPublicByHashtag(hashtag, limit) : [];
    const uniqueUserIds = [...new Set(moments.map((m) => m.userId.toString()))];
    const [authors, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findByIds(uniqueUserIds),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));

    return Promise.all(
      moments.map((moment) => this.toResponse(
        moment,
        authorById.get(moment.userId.toString()) ?? null,
        user,
        viewerFollowingIds,
        interactionContext,
      )),
    );
  }

  public async shareMoment(
    momentId: string,
    user: AuthUser,
    payload: CreateMomentShareDto = {},
  ): Promise<MomentTimelineItemResponse> {
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

    if (moment.isEventAnnouncement) {
      const event = moment.eventId ? await this.eventRepository.findById(moment.eventId.toString()) : null;
      if (!event || event.status !== "published" || event.privacy !== "public") {
        throw new AppError("Only public events can be reposted", httpStatus.BAD_REQUEST);
      }
    }

    const taggedFriendIds = [...new Set(payload.taggedFriendIds ?? [])];
    if (taggedFriendIds.length > 0) {
      const mutualFriendIds = new Set(await this.userFollowRepository.findMutualFriendIds(user.id));
      const blockedIds = new Set(await this.userBlockRepository.findBlockedIds(user.id));
      if (taggedFriendIds.some((id) => !mutualFriendIds.has(id) || blockedIds.has(id))) {
        throw new AppError("You can only tag friends in a repost", httpStatus.BAD_REQUEST);
      }
    }

    const originalType = moment.isEventAnnouncement ? "event" as const : "post" as const;
    const originalId = originalType === "event" ? moment.eventId?.toString() : momentId;
    if (!originalId) {
      throw new AppError("The original item is unavailable", httpStatus.NOT_FOUND);
    }

    const share = await this.momentShareRepository.share(user.id, momentId, {
      caption: payload.caption?.trim() || null,
      taggedFriendIds,
      originalType,
      originalId,
      clientRequestId: payload.clientRequestId ?? null,
    });

    const interactionContext = await this.buildInteractionContext([moment], user);

    const viewerFollowingIds = await this.getViewerFollowingIdSet(user);
    return this.toShareResponse(share, moment, user, viewerFollowingIds, interactionContext);
  }

  public async listFeedShares(user: AuthUser, limit = 50): Promise<MomentTimelineItemResponse[]> {
    const [shares, blockedIds] = await Promise.all([
      this.momentShareRepository.findRecent(limit),
      this.userBlockRepository.findBlockedIds(user.id),
    ]);
    const blocked = new Set(blockedIds);
    const moments = await this.momentRepository.findByIds(shares.map((share) => share.momentId.toString()));
    const momentById = new Map(moments.map((moment) => [moment._id.toString(), moment]));
    const candidates = shares
      .map((share) => ({ share, moment: momentById.get(share.momentId.toString()) }))
      .filter((entry): entry is { share: IMomentShare; moment: IMoment } => Boolean(
        entry.moment
        && entry.moment.audience === "public"
        && !blocked.has(entry.share.userId.toString())
        && !blocked.has(entry.moment.userId.toString()),
      ));
    const visibility = await Promise.all(candidates.map(async (entry) => {
      if (!entry.moment.isEventAnnouncement) return true;
      const event = entry.moment.eventId
        ? await this.eventRepository.findById(entry.moment.eventId.toString())
        : null;
      return Boolean(event && event.status === "published" && event.privacy === "public");
    }));
    const visible = candidates.filter((_entry, index) => visibility[index]);
    const visibleMoments = visible.map((entry) => entry.moment);
    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(visibleMoments, user),
    ]);

    return Promise.all(visible.map(({ share, moment }) => (
      this.toShareResponse(share, moment, user, viewerFollowingIds, interactionContext)
    )));
  }

  public async getMoment(momentId: string, user: AuthUser): Promise<MomentResponse> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment || moment.isEventAnnouncement || (moment.audience !== "public" && moment.userId.toString() !== user.id)) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    const [author, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findById(moment.userId.toString()),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext([moment], user),
    ]);

    return this.toResponse(moment, author, user, viewerFollowingIds, interactionContext);
  }

  public async toggleMomentReaction(momentId: string, user: AuthUser): Promise<MomentInteractionSummaryResponse> {
    await this.getViewableMoment(momentId, user);
    await this.momentReactionRepository.toggleLike(user.id, momentId);

    return this.getInteractionSummary(momentId, user);
  }

  public async toggleMomentSave(momentId: string, user: AuthUser): Promise<MomentSaveSummaryResponse> {
    await this.getViewableMoment(momentId, user);
    const { isSaved } = await this.momentSaveRepository.toggleSave(user.id, momentId);

    return { momentId, isSaved };
  }

  public async listSavedMoments(user: AuthUser): Promise<MomentResponse[]> {
    const saves = await this.momentSaveRepository.findByUserId(user.id);
    const momentIds = saves.map((s) => s.momentId.toString());
    const moments = await this.momentRepository.findByIds(momentIds);

    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext(moments, user),
    ]);

    const momentById = new Map(moments.map((m) => [m._id.toString(), m]));
    const orderedMoments = momentIds
      .map((id) => momentById.get(id))
      .filter((m): m is IMoment => m !== undefined);

    return Promise.all(
      orderedMoments.map((moment) => this.toResponse(moment, undefined, user, viewerFollowingIds, interactionContext)),
    );
  }

  public async toggleCommentReaction(
    momentId: string,
    commentId: string,
    user: AuthUser,
  ): Promise<{ isLiked: boolean; likesCount: number }> {
    await this.getViewableMoment(momentId, user);

    const comment = await this.momentCommentRepository.findById(commentId);

    if (!comment || comment.momentId.toString() !== momentId) {
      throw new AppError("Comment not found", httpStatus.NOT_FOUND);
    }

    const { isLiked } = await this.momentCommentReactionRepository.toggleLike(user.id, commentId);
    const likesCount = await this.momentCommentReactionRepository.countByCommentId(commentId);

    return { isLiked, likesCount };
  }

  public async deleteMoment(momentId: string, user: AuthUser): Promise<void> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.isEventAnnouncement) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.userId.toString() !== user.id) {
      throw new AppError("You can only delete your own posts", httpStatus.FORBIDDEN);
    }

    const deletedMoment = await this.momentRepository.deleteByIdForUser(momentId, user.id);

    if (!deletedMoment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    const comments = await this.momentCommentRepository.findByMomentId(momentId);
    const commentIds = comments.map((c) => c._id.toString());

    await Promise.all([
      this.momentReactionRepository.deleteByMomentId(momentId),
      this.momentCommentRepository.deleteByMomentId(momentId),
      this.momentCommentReactionRepository.deleteByCommentIds(commentIds),
      this.momentShareRepository.deleteByMomentId(momentId),
      this.momentSaveRepository.deleteByMomentId(momentId),
    ]);
  }

  public async listMomentComments(momentId: string, user: AuthUser): Promise<MomentCommentResponse[]> {
    await this.getViewableMoment(momentId, user);
    const comments = await this.momentCommentRepository.findByMomentId(momentId);

    return this.toCommentTreeResponse(comments, user);
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
    pagination?: ReturnType<typeof createPaginationMeta>;
  }>;
  public async getProfileTimeline(
    targetUserId: string,
    viewer: AuthUser | undefined,
    query: ProfileTimelineQuery,
  ): Promise<{
    items: MomentTimelineItemResponse[];
    stats: { posts: number };
    pagination: ReturnType<typeof createPaginationMeta>;
  }>;
  public async getProfileTimeline(
    targetUserId: string,
    viewer?: AuthUser,
    query: ProfileTimelineQuery = {},
  ): Promise<{
    items: MomentTimelineItemResponse[];
    stats: { posts: number };
    pagination?: ReturnType<typeof createPaginationMeta>;
  }> {
    const includePrivate = Boolean(viewer?.id && viewer.id === targetUserId);
    const targetUser = await this.userRepository.findById(targetUserId);

    if (!targetUser || !targetUser.isActive || targetUser.role !== "user") {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 10 });
    const candidateLimit = shouldPaginate ? skip + limit : undefined;
    const [authoredMoments, shares, authoredCount, shareCount] = await Promise.all([
      this.momentRepository.findByUserIdForProfile(targetUserId, includePrivate, { limit: candidateLimit }),
      this.momentShareRepository.findByUserId(targetUserId, { limit: candidateLimit }),
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
        .map(({ share, moment }) => this.toShareResponse(
          share,
          moment,
          viewer,
          viewerFollowingIds,
          interactionContext,
        )),
    );

    const sortedItems = [...authoredItems, ...sharedItems].sort(
        (firstItem, secondItem) => secondItem.createdAt.getTime() - firstItem.createdAt.getTime(),
      );
    const pageItems = shouldPaginate ? sortedItems.slice(skip, skip + limit) : sortedItems;
    const total = authoredCount + shareCount;

    return {
      items: pageItems,
      stats: {
        posts: total,
      },
      ...(shouldPaginate ? { pagination: createPaginationMeta(page, limit, total) } : {}),
    };
  }

  private async toShareResponse(
    share: IMomentShare,
    moment: IMoment,
    viewer?: AuthUser,
    viewerFollowingIds = new Set<string>(),
    interactionContext?: MomentInteractionContext,
  ): Promise<MomentTimelineItemResponse> {
    const taggedIds = (share.taggedFriendIds ?? []).map((id) => id.toString());
    const userIds = [...new Set([share.userId.toString(), ...taggedIds])];
    const users = await this.userRepository.findByIds(userIds);
    const userById = new Map(users.map((entry) => [entry._id.toString(), entry]));
    const originalType = moment.isEventAnnouncement ? "event" : (share.originalType ?? "post");
    const originalId = share.originalId?.toString()
      ?? (originalType === "event" ? moment.eventId?.toString() : moment._id.toString());

    return {
      id: share._id.toString(),
      type: "share",
      createdAt: share.createdAt,
      sharedAt: share.createdAt,
      repostCaption: share.caption ?? null,
      taggedFriends: (await Promise.all(taggedIds.map((id) => (
        this.toAuthorResponse(userById.get(id) ?? null, viewer, viewerFollowingIds)
      )))).filter((entry): entry is MomentAuthorResponse => Boolean(entry)),
      sharedBy: await this.toAuthorResponse(
        userById.get(share.userId.toString()) ?? null,
        viewer,
        viewerFollowingIds,
      ),
      originalItem: originalId ? { type: originalType, id: originalId } : undefined,
      moment: await this.toResponse(moment, undefined, viewer, viewerFollowingIds, interactionContext),
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
    const taggedFriendIds = (moment.taggedFriendIds ?? []).map((id) => id.toString());
    const [mediaItems, resolvedAuthor, taggedFriendUsers, interactionSummary, isSaved] = await Promise.all([
      Promise.all(moment.mediaItems.map((mediaItem) => this.toMediaResponse(mediaItem))),
      author === undefined ? this.userRepository.findById(moment.userId.toString()) : Promise.resolve(author),
      taggedFriendIds.length > 0 ? this.userRepository.findByIds(taggedFriendIds) : Promise.resolve([]),
      interactionContext
        ? Promise.resolve(this.getInteractionSummaryFromContext(momentId, interactionContext))
        : this.getInteractionSummary(momentId, viewer),
      interactionContext
        ? Promise.resolve(interactionContext.savedMomentIds.has(momentId))
        : viewer
          ? this.momentSaveRepository.findSavedMomentIds(viewer.id, [momentId]).then((ids) => ids.has(momentId))
          : Promise.resolve(false),
    ]);
    const taggedFriendById = new Map(taggedFriendUsers.map((entry) => [entry._id.toString(), entry]));
    const taggedFriends = (await Promise.all(taggedFriendIds.map((id) => (
      this.toAuthorResponse(taggedFriendById.get(id) ?? null, viewer, viewerFollowingIds)
    )))).filter((entry): entry is MomentAuthorResponse => Boolean(entry));

    return {
      id: momentId,
      userId: moment.userId.toString(),
      author: await this.toAuthorResponse(resolvedAuthor, viewer, viewerFollowingIds),
      mode: moment.mode,
      caption: moment.caption ?? null,
      hashtags: moment.hashtags ?? [],
      audience: moment.audience,
      taggedPeople: moment.taggedPeople,
      taggedFriends,
      eventTitle: moment.eventTitle ?? null,
      eventId: moment.eventId?.toString() ?? null,
      eventCode: moment.eventCode ?? null,
      mediaItems,
      likesCount: interactionSummary.likesCount,
      commentsCount: interactionSummary.commentsCount,
      sharesCount: interactionSummary.sharesCount,
      isLiked: interactionSummary.isLiked,
      isSaved,
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

  private async toCommentTreeResponse(comments: IMomentComment[], viewer?: AuthUser): Promise<MomentCommentResponse[]> {
    const allCommentIds = comments.map((c) => c._id.toString());
    const [likeCounts, likedCommentIds] = await Promise.all([
      this.momentCommentReactionRepository.countByCommentIds(allCommentIds),
      viewer
        ? this.momentCommentReactionRepository.findLikedCommentIds(viewer.id, allCommentIds)
        : Promise.resolve(new Set<string>()),
    ]);

    const commentsByParentId = new Map<string, IMomentComment[]>();

    comments.forEach((comment) => {
      const parentId = comment.parentCommentId?.toString() ?? "root";
      const parentComments = commentsByParentId.get(parentId) ?? [];

      parentComments.push(comment);
      commentsByParentId.set(parentId, parentComments);
    });

    const buildTree = async (comment: IMomentComment): Promise<MomentCommentResponse> => {
      const replies = commentsByParentId.get(comment._id.toString()) ?? [];
      const commentId = comment._id.toString();

      return this.toCommentResponse(
        comment,
        await Promise.all(replies.map(buildTree)),
        likeCounts.get(commentId) ?? 0,
        likedCommentIds.has(commentId),
      );
    };

    return Promise.all((commentsByParentId.get("root") ?? []).map(buildTree));
  }

  private async toCommentResponse(
    comment: IMomentComment,
    replies: MomentCommentResponse[],
    likesCount = 0,
    isLiked = false,
  ): Promise<MomentCommentResponse> {
    const author = await this.userRepository.findById(comment.userId.toString());

    return {
      id: comment._id.toString(),
      momentId: comment.momentId.toString(),
      parentCommentId: comment.parentCommentId?.toString() ?? null,
      author: await this.toCommentAuthorResponse(author),
      text: comment.text,
      likesCount,
      isLiked,
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

    if (moment.isEventAnnouncement && moment.eventId) {
      const event = await this.eventRepository.findById(moment.eventId.toString());
      if (!event || event.status === "draft") {
        throw new AppError("Moment not found", httpStatus.NOT_FOUND);
      }
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
    const [likeCounts, commentCounts, shareCounts, likedMomentIds, savedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentIds(momentIds),
      this.momentCommentRepository.countByMomentIds(momentIds),
      this.momentShareRepository.countByMomentIds(momentIds),
      viewer ? this.momentReactionRepository.findLikedMomentIds(viewer.id, momentIds) : Promise.resolve(new Set<string>()),
      viewer ? this.momentSaveRepository.findSavedMomentIds(viewer.id, momentIds) : Promise.resolve(new Set<string>()),
    ]);

    return {
      likeCounts,
      commentCounts,
      shareCounts,
      likedMomentIds,
      savedMomentIds,
    };
  }

  private emptyInteractionContext(): MomentInteractionContext {
    return {
      likeCounts: new Map(),
      commentCounts: new Map(),
      shareCounts: new Map(),
      likedMomentIds: new Set(),
      savedMomentIds: new Set(),
    };
  }

  private async getViewerFollowingIdSet(viewer?: AuthUser): Promise<Set<string>> {
    if (!viewer?.id) {
      return new Set();
    }

    return new Set(await this.userFollowRepository.findFollowingIds(viewer.id));
  }
}
