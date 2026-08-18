import { MomentRepository } from "../moments/moment.repository.js";
import { MomentReactionRepository } from "../moments/moment-reaction.repository.js";
import { MomentCommentRepository } from "../moments/moment-comment.repository.js";
import { MomentShareRepository } from "../moments/moment-share.repository.js";
import { MomentSaveRepository } from "../moments/moment-save.repository.js";

export interface EventInteractionSummary {
  interactionMomentId: string;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  isLiked: boolean;
  isSaved: boolean;
}

export interface EventInteractionSubject {
  id: string;
  userId: string;
  name?: string | null;
  description?: string | null;
}

/**
 * Canonical Event -> Interaction Moment -> reaction/comment/share summary,
 * mirroring the enrichment already used by EventService.listFeedEvents and
 * getEventById (the known-good reference implementations). Any endpoint that
 * returns an interactive Event card — Profile Hosted Events, Ticket Wallet,
 * and future ones — should build its response through this instead of
 * re-deriving its own count logic, so every surface agrees on the same
 * canonical event's counts and viewer-specific state.
 */
export class EventInteractionSummaryService {
  public constructor(
    private readonly momentRepository = new MomentRepository(),
    private readonly momentReactionRepository = new MomentReactionRepository(),
    private readonly momentCommentRepository = new MomentCommentRepository(),
    private readonly momentShareRepository = new MomentShareRepository(),
    private readonly momentSaveRepository = new MomentSaveRepository(),
  ) {}

  public async buildForEvents(
    events: EventInteractionSubject[],
    viewerId?: string,
  ): Promise<Map<string, EventInteractionSummary>> {
    if (events.length === 0) {
      return new Map();
    }

    const interactionMoments = await Promise.all(
      events.map((event) =>
        this.momentRepository.ensureEventAnnouncement({
          eventId: event.id,
          userId: event.userId,
          eventTitle: event.name ?? null,
          caption: event.description ?? null,
        }),
      ),
    );
    const momentIds = interactionMoments.map((moment) => moment._id.toString());

    const [likeCounts, commentCounts, shareCounts, likedMomentIds, savedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentIds(momentIds),
      this.momentCommentRepository.countByMomentIds(momentIds),
      this.momentShareRepository.countByMomentIds(momentIds),
      viewerId
        ? this.momentReactionRepository.findLikedMomentIds(viewerId, momentIds)
        : Promise.resolve(new Set<string>()),
      viewerId
        ? this.momentSaveRepository.findSavedMomentIds(viewerId, momentIds)
        : Promise.resolve(new Set<string>()),
    ]);

    const summaries = new Map<string, EventInteractionSummary>();

    events.forEach((event, index) => {
      const interactionMomentId = interactionMoments[index]!._id.toString();
      summaries.set(event.id, {
        interactionMomentId,
        likesCount: likeCounts.get(interactionMomentId) ?? 0,
        commentsCount: commentCounts.get(interactionMomentId) ?? 0,
        sharesCount: shareCounts.get(interactionMomentId) ?? 0,
        isLiked: likedMomentIds.has(interactionMomentId),
        isSaved: savedMomentIds.has(interactionMomentId),
      });
    });

    return summaries;
  }
}
