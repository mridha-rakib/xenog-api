import type { AuthUser } from "../auth/auth.interface.js";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { logger } from "../../core/logger/logger.js";
import { env } from "../../config/env.js";
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
  MomentLocationSnapshot,
  MomentMediaItem,
  MomentResponse,
  MomentFeedQuery,
  ProfileTimelineQuery,
  MomentSaveSummaryResponse,
  MomentTimelineItemResponse,
  UpdateMomentDto,
  UpdateMomentShareDto,
} from "./moment.interface.js";
import { extractHashtags, normalizeHashtag } from "./moment-hashtag.js";
import { MomentCommentRepository } from "./moment-comment.repository.js";
import { MomentCommentReactionRepository } from "./moment-comment-reaction.repository.js";
import { MomentReactionRepository } from "./moment-reaction.repository.js";
import { MomentSaveRepository } from "./moment-save.repository.js";
import { EventRepository } from "../events/event.repository.js";
import { getDistanceKm } from "../events/event.repository.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";
import { isOwnedMomentVideoStorageKey, MomentVideoService } from "./moment-video.service.js";
import { TranscodingMomentSyncService } from "../transcoding/transcoding-moment-sync.service.js";
import { ReportRepository } from "../reports/report.repository.js";
import { NotificationService } from "../notifications/notification.service.js";
import {
  buildReactionSocialContext,
  calculateFreshnessScore,
  calculateSmartFeedNearbyScore,
  calculateSmartFeedScore,
  calculateSocialScore,
  compareSmartFeedScoreDesc,
  isValidSmartFeedCoordinate,
  type SmartFeedAuthorRelationship,
  type SmartFeedScore,
  type SmartFeedSocialContext,
  type SmartFeedSocialUser,
} from "../feed/smart-feed-ranking.js";
import { GeoIpService } from "../geoip/geoip.service.js";

const MOMENT_ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

const nowMs = (): number => Number(process.hrtime.bigint() / 1000000n);

interface MomentInteractionContext {
  likeCounts: Map<string, number>;
  commentCounts: Map<string, number>;
  shareCounts: Map<string, number>;
  likedMomentIds: Set<string>;
  savedMomentIds: Set<string>;
  reportedMomentIds: Set<string>;
}

type MomentSmartFeedContext = {
  scoreByMomentId: Map<string, SmartFeedScore>;
  socialContextByMomentId: Map<string, SmartFeedSocialContext>;
};

type MomentRequestContext = {
  clientIp?: string | null;
};

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
    private readonly momentVideoService = new MomentVideoService(storageService),
    private readonly transcodingMomentSyncService = new TranscodingMomentSyncService(),
    private readonly reportRepository = new ReportRepository(),
    private readonly geoIpService = new GeoIpService(),
    private readonly notificationService = new NotificationService(),
  ) {}

  public async createVideoUpload(user: AuthUser, contentType: string): Promise<Record<string, unknown>> {
    return this.momentVideoService.createUpload(user, contentType);
  }

  public async uploadVideo(payload: {
    user: AuthUser;
    key: string;
    contentType: string;
    body: Buffer;
  }): Promise<{ key: string }> {
    return this.momentVideoService.uploadObject(payload);
  }

  public async createMoment(
    payload: CreateMomentDto,
    user: AuthUser,
    context: MomentRequestContext = {},
  ): Promise<MomentResponse> {
    const startedAt = nowMs();
    const hasVideo = payload.mediaItems?.some((mediaItem) => mediaItem.type === "video") ?? false;
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

    const validationStartedAt = nowMs();
    const mediaItems = await this.validateCreateMomentMediaItems(payload.mediaItems ?? [], user);
    const mediaValidationMs = nowMs() - validationStartedAt;
    const location = await this.buildMomentLocationSnapshot(user.id, context.clientIp);

    const persistenceStartedAt = nowMs();
    let moment = await this.momentRepository.create({
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
      mediaItems,
      location,
    });
    const persistenceMs = nowMs() - persistenceStartedAt;

    if (hasVideo) {
      moment = await this.queueVideoProcessingJobs(moment, user);

      logger.info(
        {
          userId: user.id,
          mediaValidationMs,
          persistenceMs,
          totalMs: nowMs() - startedAt,
        },
        "Create Post video Moment persisted",
      );
    }

    return this.toResponse(moment, undefined, user, new Set(), this.emptyInteractionContext());
  }

  /**
   * Queues a Phase 2 transcoding job for every eligible video media item on
   * a just-created Moment, and folds each resulting "queued" write back onto
   * the in-memory Moment so the response reflects it without a re-fetch.
   * Only ever called for a freshly created Moment (never on existing/legacy
   * records) — every video item here already passed
   * validateCreateMomentVideo() (owned Moment-video storage key, no client
   * URL, no processing fields), so no further eligibility filtering beyond
   * type/storageKey is needed.
   */
  private async queueVideoProcessingJobs(moment: IMoment, user: AuthUser): Promise<IMoment> {
    let current = moment;

    for (const mediaItem of moment.mediaItems) {
      if (mediaItem.type !== "video" || !mediaItem.storageKey) {
        continue;
      }

      const updated = await this.transcodingMomentSyncService.queueNewVideoJob({
        momentId: current._id.toString(),
        userId: user.id,
        sourceStorageKey: mediaItem.storageKey,
        sourceContentType: mediaItem.contentType ?? null,
      });

      if (updated) {
        current = updated;
      }
    }

    return current;
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

  private async validateCreateMomentMediaItems(mediaItems: MomentMediaItem[], user: AuthUser): Promise<MomentMediaItem[]> {
    const validatedMediaItems: MomentMediaItem[] = [];

    for (const mediaItem of mediaItems) {
      if (mediaItem.type === "video") {
        validatedMediaItems.push(await this.momentVideoService.validateCreateMomentVideo(mediaItem, user));
        continue;
      }

      if (mediaItem.storageKey && isOwnedMomentVideoStorageKey(mediaItem.storageKey, user.id)) {
        throw new AppError("Video files must be submitted as video media.", httpStatus.BAD_REQUEST);
      }

      validatedMediaItems.push(mediaItem);
    }

    return validatedMediaItems;
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

  public async listFeedMoments(
    user: AuthUser,
    query: MomentFeedQuery = {},
    context: MomentRequestContext = {},
  ): Promise<MomentResponse[]> {
    const hashtags = query.hashtags?.map(normalizeHashtag).filter(Boolean);
    const isSmartFeedEnabled = env.ENABLE_SMART_FEED === true;
    const shouldLoadFriendIds = isSmartFeedEnabled || query.audience === "friends";
    // followingIds was previously fetched separately (via getViewerFollowingIdSet)
    // only for the isFollowing UI badge. Fetched here instead so Smart Feed
    // scoring can reuse the exact same query — no second follow-graph read.
    const [excludeUserIds, blockerUserIds, friendIds, followingIds] = await Promise.all([
      this.userBlockRepository.findBlockedIds(user.id),
      isSmartFeedEnabled ? this.userBlockRepository.findBlockerIds(user.id) : Promise.resolve([]),
      shouldLoadFriendIds
        ? this.userFollowRepository.findMutualFriendIds(user.id)
        : Promise.resolve([]),
      this.userFollowRepository.findFollowingIds(user.id),
    ]);
    const viewerFollowingIds = new Set(followingIds);
    // Friends candidate authors = self + mutual friends. findMutualFriendIds
    // never includes the viewer's own id (a user isn't their own
    // follower/following), so without this the viewer's own Moments were
    // silently excluded from their own Friends tab — this is the only line
    // that changes Friends eligibility; scoring's mutualAuthor relationship
    // (smartFeedFriendIds below) is untouched and still excludes self, since
    // self relevance is already handled by the existing isAuthorSelf signal.
    const authorUserIds = query.audience === "friends" ? [...friendIds, user.id] : undefined;
    const candidateEventIds = await this.momentRepository.findFeedCandidateEventIds({
      ...query,
      hashtags,
      excludeUserIds,
      authorUserIds,
    });
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
      authorUserIds,
    });
    const uniqueUserIds = [...new Set(moments.map((m) => m.userId.toString()))];
    const smartFeedFriendIds = isSmartFeedEnabled
      ? friendIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const smartFeedFollowedIds = isSmartFeedEnabled
      ? followingIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const [authors, interactionContext, smartFeedContext] = await Promise.all([
      this.userRepository.findByIds(uniqueUserIds),
      this.buildInteractionContext(moments, user),
      isSmartFeedEnabled
        ? this.buildMomentSmartFeedContext(moments, user.id, smartFeedFriendIds, smartFeedFollowedIds, query, context)
        : Promise.resolve(undefined),
    ]);
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));
    const responses = await Promise.all(
      moments.map((moment) => this.toResponse(
        moment,
        authorById.get(moment.userId.toString()) ?? null,
        user,
        viewerFollowingIds,
        interactionContext,
        smartFeedContext,
      )),
    );

    return isSmartFeedEnabled ? responses.sort(compareSmartFeedScoreDesc) : responses;
  }

  // Hashtag eligibility (findPublicByHashtag) is the hard match filter and is untouched —
  // this only reorders the already-matching set using the exact same Smart Feed scoring
  // already used by listFeedMoments (nearby/freshness/social), so a fresh own/mutual/
  // followed post can outrank an older unrelated match without inventing new weights.
  // No latitude/longitude query param exists for this endpoint — viewer location falls
  // back to GeoIP (context.clientIp) exactly as calculateSmartFeedNearbyScore already
  // supports; no GPS is required and nothing here forces a new location prompt.
  public async listHashtagMoments(
    hashtagValue: string,
    user: AuthUser,
    limit = 100,
    context: MomentRequestContext = {},
  ): Promise<MomentResponse[]> {
    const hashtag = normalizeHashtag(hashtagValue);
    const isSmartFeedEnabled = env.ENABLE_SMART_FEED === true;
    const moments = hashtag ? await this.momentRepository.findPublicByHashtag(hashtag, limit) : [];
    const uniqueUserIds = [...new Set(moments.map((m) => m.userId.toString()))];
    const [authors, viewerFollowingIds, interactionContext, excludeUserIds, blockerUserIds, friendIds, followingIds] =
      await Promise.all([
        this.userRepository.findByIds(uniqueUserIds),
        this.getViewerFollowingIdSet(user),
        this.buildInteractionContext(moments, user),
        isSmartFeedEnabled ? this.userBlockRepository.findBlockedIds(user.id) : Promise.resolve([]),
        isSmartFeedEnabled ? this.userBlockRepository.findBlockerIds(user.id) : Promise.resolve([]),
        isSmartFeedEnabled ? this.userFollowRepository.findMutualFriendIds(user.id) : Promise.resolve([]),
        isSmartFeedEnabled ? this.userFollowRepository.findFollowingIds(user.id) : Promise.resolve([]),
      ]);
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));
    const smartFeedFriendIds = isSmartFeedEnabled
      ? friendIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const smartFeedFollowedIds = isSmartFeedEnabled
      ? followingIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const smartFeedContext = isSmartFeedEnabled
      ? await this.buildMomentSmartFeedContext(moments, user.id, smartFeedFriendIds, smartFeedFollowedIds, {}, context)
      : undefined;

    const responses = await Promise.all(
      moments.map((moment) => this.toResponse(
        moment,
        authorById.get(moment.userId.toString()) ?? null,
        user,
        viewerFollowingIds,
        interactionContext,
        smartFeedContext,
      )),
    );

    return isSmartFeedEnabled ? responses.sort(compareSmartFeedScoreDesc) : responses;
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
      if (
        !event ||
        (event.status !== "published" && event.status !== "live") ||
        event.privacy !== "public"
      ) {
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

    const { share, isNew } = await this.momentShareRepository.share(user.id, momentId, {
      caption: payload.caption?.trim() || null,
      taggedFriendIds,
      originalType,
      originalId,
      clientRequestId: payload.clientRequestId ?? null,
    });

    // Only a genuinely new share (isNew) notifies — the share() upsert is a
    // deliberate no-op when this user already reposted this content, and
    // that idempotent retry must never re-notify the owner.
    if (isNew) {
      await this.sendMomentInteractionNotification({
        moment,
        actor: user,
        type: "moment_share",
        sourceKey: `share:${share._id.toString()}`,
      });
    }

    const interactionContext = await this.buildInteractionContext([moment], user);

    const viewerFollowingIds = await this.getViewerFollowingIdSet(user);
    return this.toShareResponse(share, moment, user, viewerFollowingIds, interactionContext);
  }

  /**
   * Owner-only edit of a repost's own commentary. Ownership is checked
   * against the SHARE's userId (the reposter), never the original content's
   * author — a user may always edit their own repost commentary regardless
   * of who authored the original Post/Event, and can never touch the
   * original content, taggedFriendIds, momentId, originalType/originalId, or
   * clientRequestId through this path. Uses MomentShareRepository's
   * updateCaptionForUser (a real $set), never the create-only share() upsert.
   */
  public async updateMomentShare(
    shareId: string,
    user: AuthUser,
    payload: UpdateMomentShareDto,
  ): Promise<MomentTimelineItemResponse> {
    const share = await this.momentShareRepository.findById(shareId);

    if (!share) {
      throw new AppError("Repost not found", httpStatus.NOT_FOUND);
    }

    if (share.userId.toString() !== user.id) {
      throw new AppError("You can only edit your own repost", httpStatus.FORBIDDEN);
    }

    const moment = await this.momentRepository.findById(share.momentId.toString());

    if (!moment) {
      throw new AppError("Repost not found", httpStatus.NOT_FOUND);
    }

    const caption = payload.caption?.trim() || null;
    const updated = await this.momentShareRepository.updateCaptionForUser(shareId, user.id, caption);

    if (!updated) {
      throw new AppError("Repost not found", httpStatus.NOT_FOUND);
    }

    const [viewerFollowingIds, interactionContext] = await Promise.all([
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext([moment], user),
    ]);

    return this.toShareResponse(updated, moment, user, viewerFollowingIds, interactionContext);
  }

  public async listFeedShares(
    user: AuthUser,
    limit = 50,
    audience?: "discover" | "friends",
  ): Promise<MomentTimelineItemResponse[]> {
    const [shares, blockedIds, friendIds] = await Promise.all([
      this.momentShareRepository.findRecent(limit),
      this.userBlockRepository.findBlockedIds(user.id),
      audience === "friends"
        ? this.userFollowRepository.findMutualFriendIds(user.id)
        : Promise.resolve([]),
    ]);
    const blocked = new Set(blockedIds);
    const friendIdSet = new Set(friendIds);
    const moments = await this.momentRepository.findByIds(shares.map((share) => share.momentId.toString()));
    const momentById = new Map(moments.map((moment) => [moment._id.toString(), moment]));
    const candidates = shares
      .map((share) => ({ share, moment: momentById.get(share.momentId.toString()) }))
      .filter((entry): entry is { share: IMomentShare; moment: IMoment } => Boolean(
        entry.moment
        && entry.moment.audience === "public"
        && !blocked.has(entry.share.userId.toString())
        && !blocked.has(entry.moment.userId.toString())
        && (audience !== "friends" || friendIdSet.has(entry.share.userId.toString())),
      ));
    const visibility = await Promise.all(candidates.map(async (entry) => {
      if (!entry.moment.isEventAnnouncement) return true;
      const event = entry.moment.eventId
        ? await this.eventRepository.findById(entry.moment.eventId.toString())
        : null;
      return Boolean(
        event &&
        (event.status === "published" || event.status === "live") &&
        event.privacy === "public",
      );
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
    const moment = await this.getViewableMoment(momentId, user);
    const { isLiked, reaction } = await this.momentReactionRepository.toggleLike(user.id, momentId);

    // Only a newly-created reaction (a fresh like, not an unlike/toggle-off)
    // should notify — reaction is only non-null when toggleLike just created
    // a row, so this is the backend-authoritative "like created" signal, not
    // an inference from the previous frontend isLiked boolean.
    if (isLiked && reaction) {
      await this.sendMomentInteractionNotification({
        moment,
        actor: user,
        type: "moment_reaction",
        sourceKey: `reaction:${momentId}:${user.id}`,
      });
    }

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
      // Only reached after ownership is already confirmed and the Moment is
      // already successfully hard-deleted above — stops any queued/active
      // transcoding work for its video media and prevents a later crash-
      // recovery sweep from ever repointing a Moment that no longer exists.
      this.transcodingMomentSyncService.cancelForDeletedMoment(momentId),
    ]);
  }

  /**
   * Owner-only, caption-only edit of an existing Moment/Post. Reuses the same
   * existence/event-announcement/ownership checks as deleteMoment() above, so
   * a synthetic Event announcement Moment can never be edited through this
   * path (the Event itself has its own dedicated edit flow). Hashtags are
   * re-derived from the updated caption via the canonical extractHashtags()
   * parser — never merged with the previous set — and createdAt is never
   * touched, so Smart Feed freshness is unaffected.
   */
  public async updateMoment(momentId: string, user: AuthUser, payload: UpdateMomentDto): Promise<MomentResponse> {
    const moment = await this.momentRepository.findById(momentId);

    if (!moment || moment.isEventAnnouncement) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.userId.toString() !== user.id) {
      throw new AppError("You can only edit your own posts", httpStatus.FORBIDDEN);
    }

    const caption = payload.caption?.trim() || null;

    if (!caption && moment.mediaItems.length === 0) {
      throw new AppError("Write a stitch or attach media before creating a moment", httpStatus.BAD_REQUEST);
    }

    const hashtags = extractHashtags(caption);
    const updated = await this.momentRepository.updateCaptionForUser(momentId, user.id, { caption, hashtags });

    if (!updated) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    const [author, viewerFollowingIds, interactionContext] = await Promise.all([
      this.userRepository.findById(updated.userId.toString()),
      this.getViewerFollowingIdSet(user),
      this.buildInteractionContext([updated], user),
    ]);

    return this.toResponse(updated, author, user, viewerFollowingIds, interactionContext);
  }

  /**
   * Phase 3B2B: owner-authorized manual retry for a Moment's failed video
   * processing. Reuses the exact same existence/event-announcement/ownership
   * checks as deleteMoment() above. Media items carry no stable server-issued
   * id (see MomentMediaItem/_id:false on the schema), so eligibility is
   * determined entirely server-side — every video media item currently
   * `processingStatus:"failed"` is retried by its own immutable source
   * storage key; the client never supplies a job id or a storage key.
   * Currently a Moment realistically has at most one such item, but every
   * eligible one is retried so this stays correct if that ever changes.
   */
  public async retryMomentVideoProcessing(momentId: string, user: AuthUser): Promise<MomentResponse> {
    if (!env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video processing is temporarily unavailable.", httpStatus.BAD_REQUEST);
    }

    const moment = await this.momentRepository.findById(momentId);

    if (!moment) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.isEventAnnouncement) {
      throw new AppError("Moment not found", httpStatus.NOT_FOUND);
    }

    if (moment.userId.toString() !== user.id) {
      throw new AppError("You can only retry your own posts", httpStatus.FORBIDDEN);
    }

    const eligibleSourceKeys = moment.mediaItems
      .filter((item): item is MomentMediaItem & { storageKey: string } => (
        item.type === "video" && item.processingStatus === "failed" && Boolean(item.storageKey)
      ))
      .map((item) => item.storageKey);

    if (eligibleSourceKeys.length === 0) {
      throw new AppError("There is no failed video to retry for this post", httpStatus.CONFLICT);
    }

    let current = moment;
    let retriedAny = false;

    for (const sourceStorageKey of eligibleSourceKeys) {
      const result = await this.transcodingMomentSyncService.retryFailedVideoProcessing(momentId, sourceStorageKey, user.id);

      if (result.outcome === "retried") {
        current = result.moment;
        retriedAny = true;
      }
    }

    if (!retriedAny) {
      throw new AppError("This video is no longer available to retry", httpStatus.CONFLICT);
    }

    return this.toResponse(current, undefined, user, new Set(), this.emptyInteractionContext());
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
    const moment = await this.getViewableMoment(momentId, user);

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

    // sourceKey is the comment's own id, so every successfully-created
    // comment produces exactly one notification — this does not dedupe two
    // distinct (possibly duplicate-submitted) comment documents against each
    // other, which is intentional: comment creation has no request-level
    // idempotency today, and fixing that is out of scope here.
    await this.sendMomentInteractionNotification({
      moment,
      actor: user,
      type: "moment_comment",
      sourceKey: `comment:${comment._id.toString()}`,
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

    if (viewer?.id && viewer.id !== targetUserId) {
      const [viewerHasBlockedTarget, targetHasBlockedViewer] = await Promise.all([
        this.userBlockRepository.isBlocked(viewer.id, targetUserId),
        this.userBlockRepository.isBlocked(targetUserId, viewer.id),
      ]);

      if (viewerHasBlockedTarget || targetHasBlockedViewer) {
        throw new AppError("Profile unavailable", httpStatus.FORBIDDEN);
      }
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
    smartFeedContext?: MomentSmartFeedContext,
  ): Promise<MomentResponse> {
    const momentId = moment._id.toString();
    const taggedFriendIds = (moment.taggedFriendIds ?? []).map((id) => id.toString());
    const [mediaItems, resolvedAuthor, taggedFriendUsers, interactionSummary, isSaved, hasReported] = await Promise.all([
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
      interactionContext
        ? Promise.resolve(interactionContext.reportedMomentIds.has(momentId))
        : viewer
          ? this.reportRepository.hasReported(viewer.id, "post", momentId)
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
      ...(moment.location ? { location: moment.location } : {}),
      likesCount: interactionSummary.likesCount,
      commentsCount: interactionSummary.commentsCount,
      sharesCount: interactionSummary.sharesCount,
      isLiked: interactionSummary.isLiked,
      isSaved,
      hasReported,
      ...(smartFeedContext?.socialContextByMomentId.get(momentId)
        ? { socialContext: smartFeedContext.socialContextByMomentId.get(momentId) }
        : {}),
      ...(smartFeedContext?.scoreByMomentId.get(momentId)
        ? {
            smartFeed: smartFeedContext.scoreByMomentId.get(momentId),
            smartFeedScore: smartFeedContext.scoreByMomentId.get(momentId)?.finalScore,
          }
        : {}),
      createdAt: moment.createdAt,
      updatedAt: moment.updatedAt,
    };
  }

  private async buildMomentLocationSnapshot(
    userId: string,
    clientIp?: string | null,
  ): Promise<MomentLocationSnapshot | null> {
    try {
      const user = await this.userRepository.findById(userId);
      const currentLocation = user?.currentLocation;

      if (
        user?.currentLocationSharingEnabled === true &&
        isValidSmartFeedCoordinate(currentLocation?.latitude, currentLocation?.longitude)
      ) {
        return {
          source: "gps",
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
          accuracy: currentLocation.accuracy ?? null,
          capturedAt: currentLocation.updatedAt ?? new Date(),
        };
      }
    } catch (error) {
      logger.warn({ err: error, userId }, "Skipping Moment location snapshot");
    }

    return this.buildIpLocationSnapshot(clientIp);
  }

  private async buildIpLocationSnapshot(clientIp?: string | null): Promise<MomentLocationSnapshot | null> {
    try {
      const geoIpLocation = await this.geoIpService.lookup(clientIp);

      if (!geoIpLocation) {
        return null;
      }

      return {
        ...geoIpLocation,
        capturedAt: new Date(),
      };
    } catch (error) {
      logger.warn({ err: error }, "Skipping GeoIP Moment location snapshot");
      return null;
    }
  }

  private async buildMomentSmartFeedContext(
    moments: IMoment[],
    viewerId: string,
    mutualFriendIds: string[],
    followedAuthorIds: string[],
    query: MomentFeedQuery,
    context: MomentRequestContext,
  ): Promise<MomentSmartFeedContext> {
    const momentIds = moments.map((moment) => moment._id.toString());
    const mutualFriendSet = new Set(mutualFriendIds);
    // "followed-only" = one-way follows that aren't already mutual friends,
    // so a reactor/reposter is never counted toward both signals at once.
    const followedOnlyIds = followedAuthorIds.filter((id) => !mutualFriendSet.has(id));
    const followedOnlySet = new Set(followedOnlyIds);
    const relationshipUserIds = [...new Set([...mutualFriendIds, ...followedOnlyIds])];

    const [reactedUserIdsByMomentId, reposterUserIdsByMomentId] = await Promise.all([
      this.momentReactionRepository.findLikedUserIdsByMomentIds(momentIds, relationshipUserIds),
      this.momentShareRepository.findReposterUserIdsByMomentIds(momentIds, relationshipUserIds),
    ]);

    // The visible "X and Y reacted" preview stays scoped to mutual friends
    // only, exactly as before — one-way-followed reactors influence scoring
    // (below) but never widen this existing UI-facing preview list.
    const mutualReactedUserIds = [...new Set(
      [...reactedUserIdsByMomentId.values()].flat().filter((id) => mutualFriendSet.has(id)),
    )];
    const reactedUsers = mutualReactedUserIds.length > 0
      ? await this.userRepository.findActiveUsersByIds(mutualReactedUserIds, undefined, mutualReactedUserIds.length)
      : [];
    const userById = new Map<string, SmartFeedSocialUser>(
      reactedUsers.map((item) => [item._id.toString(), {
        id: item._id.toString(),
        name: item.name,
        avatarKey: item.avatarKey ?? null,
      }]),
    );
    const viewerLocation = isValidSmartFeedCoordinate(query.latitude, query.longitude)
      ? { latitude: query.latitude, longitude: query.longitude }
      : null;
    const viewerRegionalLocation = viewerLocation
      ? null
      : await this.geoIpService.lookup(context.clientIp);
    const scoreByMomentId = new Map<string, SmartFeedScore>();
    const socialContextByMomentId = new Map<string, SmartFeedSocialContext>();
    const now = new Date();

    for (const moment of moments) {
      const momentId = moment._id.toString();
      const reactedUserIdsForMoment = reactedUserIdsByMomentId.get(momentId) ?? [];
      const mutualReactedForMoment = reactedUserIdsForMoment.filter((id) => mutualFriendSet.has(id));
      const followedReactedForMoment = reactedUserIdsForMoment.filter((id) => followedOnlySet.has(id));
      const socialContext = buildReactionSocialContext(mutualReactedForMoment, userById);

      if (socialContext) {
        socialContextByMomentId.set(momentId, socialContext);
      }

      const reposterIdsForMoment = reposterUserIdsByMomentId.get(momentId) ?? [];
      const mutualRepostCount = reposterIdsForMoment.filter((id) => mutualFriendSet.has(id)).length;
      const followedRepostCount = reposterIdsForMoment.filter((id) => followedOnlySet.has(id)).length;

      const authorId = moment.userId.toString();
      const authorRelationship: SmartFeedAuthorRelationship = mutualFriendSet.has(authorId)
        ? "mutual"
        : followedOnlySet.has(authorId)
          ? "followed"
          : "none";

      const score = calculateSmartFeedScore({
        isAuthorSelf: authorId === viewerId,
        nearbyScore: calculateSmartFeedNearbyScore({
          viewerExactLocation: viewerLocation,
          viewerRegionalLocation,
          itemLocation: moment.location,
          distanceKm: getDistanceKm,
        }),
        freshnessScore: calculateFreshnessScore(moment.createdAt, now),
        socialScore: calculateSocialScore({
          authorRelationship,
          mutualReactionUserCount: new Set(mutualReactedForMoment).size,
          followedReactionUserCount: new Set(followedReactedForMoment).size,
          mutualRepostUserCount: mutualRepostCount,
          followedRepostUserCount: followedRepostCount,
        }),
      });

      scoreByMomentId.set(momentId, score);
    }

    return {
      scoreByMomentId,
      socialContextByMomentId,
    };
  }

  private async toMediaResponse(mediaItem: MomentMediaItem): Promise<MomentMediaItem> {
    const plainMediaItem = typeof (mediaItem as unknown as { toObject?: () => MomentMediaItem }).toObject === "function"
      ? (mediaItem as unknown as { toObject: () => MomentMediaItem }).toObject()
      : mediaItem;

    if (plainMediaItem.type === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      // Video is temporarily disabled — never resolve/return a playable URL
      // *or* the raw storageKey for video media, even for existing content.
      // storageKey is redacted too (not just url) because GET /storage/file
      // resolves any storageKey it's given, unauthenticated, so leaving the
      // key in the response would still let a client stream the video
      // directly. The media item's other fields (type, processingStatus,
      // engagement counts on the parent Moment) are kept unchanged so
      // mixed-media Moments and media indices are unaffected. The mobile
      // client already drops media items with no url from what it renders
      // (lib/momentPostMapper.ts), so this also removes video tiles from
      // the feed for existing content without any array-shape risk.
      return { ...plainMediaItem, url: null, storageKey: null };
    }

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

  /**
   * Central notification side effect for the three social interaction write
   * paths (reaction/comment/share), shared by every calling surface (Feed,
   * Profile Timeline, Event Details, Profile Events) since they all funnel
   * through toggleMomentReaction/createMomentComment/shareMoment. Resolves
   * the recipient from the Moment's own userId — for an Event's Interaction
   * Moment this is kept in lockstep with Event.userId by
   * MomentRepository.ensureEventAnnouncement, so it already identifies the
   * real Event host, not some other account. contentType/eventId/momentId
   * are set explicitly (never inferred from the notification type alone) so
   * the frontend can never mistake an Event interaction for a standalone
   * Post — an Interaction Moment is never eligible as a Post navigation
   * target. Failures here are caught and logged, never thrown: a push/DB
   * hiccup must not turn a successful reaction/comment/share into a failed
   * request.
   */
  private async sendMomentInteractionNotification(params: {
    moment: IMoment;
    actor: AuthUser;
    type: "moment_reaction" | "moment_comment" | "moment_share";
    sourceKey: string;
  }): Promise<void> {
    const { moment, actor, type, sourceKey } = params;
    const recipientUserId = moment.userId.toString();

    if (recipientUserId === actor.id) {
      return;
    }

    try {
      const isEvent = Boolean(moment.isEventAnnouncement && moment.eventId);
      const contentType = isEvent ? "event" as const : "post" as const;
      const targetLabel = isEvent ? "event" : "post";
      const verb = type === "moment_reaction" ? "liked" : type === "moment_comment" ? "commented on" : "shared";
      const title = type === "moment_reaction" ? "New reaction" : type === "moment_comment" ? "New comment" : "New share";

      await this.notificationService.sendSystemNotification(
        recipientUserId,
        type,
        `${actor.name} ${verb} your ${targetLabel}.`,
        {
          title,
          actorUserId: actor.id,
          actorName: actor.name,
          actorUsername: actor.username ?? null,
          actorAvatarKey: actor.avatarKey ?? null,
          contentType,
          eventId: isEvent ? moment.eventId!.toString() : null,
          momentId: isEvent ? null : moment._id.toString(),
          eventName: isEvent ? (moment.eventTitle ?? null) : null,
          sourceKey,
        },
      );
    } catch (error) {
      logger.warn(
        { err: error, momentId: moment._id.toString(), actorId: actor.id, type },
        "Failed to send moment interaction notification",
      );
    }
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
    const [likeCounts, commentCounts, shareCounts, likedMomentIds, savedMomentIds, reportedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentIds(momentIds),
      this.momentCommentRepository.countByMomentIds(momentIds),
      this.momentShareRepository.countByMomentIds(momentIds),
      viewer ? this.momentReactionRepository.findLikedMomentIds(viewer.id, momentIds) : Promise.resolve(new Set<string>()),
      viewer ? this.momentSaveRepository.findSavedMomentIds(viewer.id, momentIds) : Promise.resolve(new Set<string>()),
      viewer ? this.reportRepository.findReportedTargetIds(viewer.id, "post", momentIds) : Promise.resolve(new Set<string>()),
    ]);

    return {
      likeCounts,
      commentCounts,
      shareCounts,
      likedMomentIds,
      savedMomentIds,
      reportedMomentIds,
    };
  }

  private emptyInteractionContext(): MomentInteractionContext {
    return {
      likeCounts: new Map(),
      commentCounts: new Map(),
      shareCounts: new Map(),
      likedMomentIds: new Set(),
      savedMomentIds: new Set(),
      reportedMomentIds: new Set(),
    };
  }

  private async getViewerFollowingIdSet(viewer?: AuthUser): Promise<Set<string>> {
    if (!viewer?.id) {
      return new Set();
    }

    return new Set(await this.userFollowRepository.findFollowingIds(viewer.id));
  }
}
