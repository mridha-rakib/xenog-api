import type { Types } from "mongoose";
import type { EventImageDisplay } from "../events/event.interface.js";

export const eventWindowContentTypes = ["text", "image", "video", "audio"] as const;
export type EventWindowContentType = (typeof eventWindowContentTypes)[number];

export const eventWindowStatuses = ["scheduled", "cancelled"] as const;
export type EventWindowStatus = (typeof eventWindowStatuses)[number];

export const eventWindowPostStatuses = ["accepted", "removed"] as const;
export type EventWindowPostStatus = (typeof eventWindowPostStatuses)[number];

// Who may post into a window: any current valid ticket holder (no check-in
// required), or only attendees who have actually been scanned in.
export const eventWindowPostingEligibilities = ["ticket_holders", "checked_in_attendees"] as const;
export type EventWindowPostingEligibility = (typeof eventWindowPostingEligibilities)[number];

// When a participant who has posted can see everyone else's accepted posts
// in that same window: immediately after their own post is accepted, or
// only once the event has completed.
export const eventWindowParticipantPostVisibilities = ["instant", "end_of_event"] as const;
export type EventWindowParticipantPostVisibility = (typeof eventWindowParticipantPostVisibilities)[number];

// Legacy default: every window created before these fields existed behaved
// exactly like check-in-required posting with an end-of-event reveal.
export const DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY: EventWindowPostingEligibility = "checked_in_attendees";
export const DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY: EventWindowParticipantPostVisibility = "end_of_event";

export const eventWindowMediaTypes = ["image", "video", "audio"] as const;
export type EventWindowMediaType = (typeof eventWindowMediaTypes)[number];

export const eventWindowMediaSources = ["gallery", "camera", "upload", "external"] as const;
export type EventWindowMediaSource = (typeof eventWindowMediaSources)[number];

export const MAX_EVENT_WINDOW_POSTS = 10_000;
export const DEFAULT_EVENT_WINDOW_POST_PAGE_SIZE = 20;
export const MAX_EVENT_WINDOW_POST_PAGE_SIZE = 50;
export const EVENT_WINDOW_MEDIA_LIMITS_BYTES = {
  image: 15 * 1024 * 1024,
  video: 300 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
} as const satisfies Record<EventWindowMediaType, number>;

export interface EventWindowMediaItem {
  type: EventWindowMediaType;
  source: EventWindowMediaSource;
  url?: string | null;
  storageKey?: string | null;
  contentType?: string | null;
  durationSeconds?: number | null;
}

export interface IEventWindow {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  hostUserId: Types.ObjectId;
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
  acceptedPostCount: number;
  status: EventWindowStatus;
  postingEligibility: EventWindowPostingEligibility;
  participantPostVisibility: EventWindowParticipantPostVisibility;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// The exact ticket-pass identity tuple used everywhere else in the ticket
// domain (TicketShare, TicketUsage, TicketCancellation) — reused here rather
// than inventing a new reference, so a `ticket_holders`-authorized post can
// be traced back to the entitlement that authorized it.
export interface EventWindowPostTicketEntitlement {
  orderId: Types.ObjectId;
  ticketId: string;
  ticketIndex: number;
  source: "owned" | "shared";
}

export interface IEventWindowPost {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  windowId: Types.ObjectId;
  userId: Types.ObjectId;
  // Populated only when the window's postingEligibility is
  // "checked_in_attendees" — the TicketUsage row proving check-in.
  ticketUsageId?: Types.ObjectId | null;
  // Populated only when the window's postingEligibility is "ticket_holders"
  // — the ticket entitlement (owned or shared-in) proving current holdership.
  ticketEntitlement?: EventWindowPostTicketEntitlement | null;
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems: EventWindowMediaItem[];
  status: EventWindowPostStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEventWindowDto {
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
  postingEligibility?: EventWindowPostingEligibility;
  participantPostVisibility?: EventWindowParticipantPostVisibility;
}

// Posting eligibility and participant visibility are create-time-only policy
// decisions — changing them after posts already exist would silently alter
// rights participants already relied on when they posted, so they are
// intentionally excluded from the editable field set.
export type UpdateEventWindowDto = Partial<Omit<CreateEventWindowDto, "postingEligibility" | "participantPostVisibility">>;

export interface CreateEventWindowPostDto {
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems?: EventWindowMediaItem[];
}

export type EventWindowComputedStatus = "scheduled" | "open" | "closed" | "cancelled";

export interface EventWindowResponse {
  id: string;
  eventId: string;
  hostUserId: string;
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
  acceptedPostCount: number;
  status: EventWindowStatus;
  computedStatus: EventWindowComputedStatus;
  postingEligibility: EventWindowPostingEligibility;
  participantPostVisibility: EventWindowParticipantPostVisibility;
  cancelledAt?: Date | null;
  // Whether the caller has a TicketUsage row for this event at all
  // (informational — independent of this window's postingEligibility).
  hasAttended: boolean;
  hasPosted: boolean;
  // Whether the caller currently satisfies THIS window's postingEligibility
  // (ticket_holders → valid entitlement; checked_in_attendees → checked in).
  isEligibleToPost: boolean;
  canPost: boolean;
  canViewPosts: boolean;
  remainingSlots: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventWindowPostMediaResponse {
  type: EventWindowMediaType;
  source: EventWindowMediaSource;
  url?: string | null;
  contentType?: string | null;
  durationSeconds?: number | null;
}

export interface EventWindowPostResponse {
  id: string;
  eventId: string;
  windowId: string;
  userId: string;
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems: EventWindowPostMediaResponse[];
  status: EventWindowPostStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListEventWindowPostsOptions {
  limit: number;
  cursor?: string;
}

export interface EventWindowPostListResponse {
  posts: EventWindowPostResponse[];
  nextCursor: string | null;
}

export const DEFAULT_PARTICIPATED_EVENTS_LIMIT = 20;
export const MAX_PARTICIPATED_EVENTS_LIMIT = 50;
// Hard cap on how many of the caller's own accepted posts are scanned to
// build the participated-events list — bounds the query regardless of a
// user's lifetime post count. Deliberately not cursor-paginated (see
// event-window.service.ts#listParticipatedEvents) since grouping posts into
// events first makes a stable per-page cursor non-trivial, and a user's
// realistic participation history is small; this cap is the simpler,
// still-bounded alternative.
export const PARTICIPATED_POSTS_SCAN_LIMIT = 300;

export interface ListParticipatedEventsOptions {
  limit: number;
}

// Navigation metadata only — never the posts themselves. Actual gallery
// content stays behind the existing authorized listPosts/media endpoints.
export interface ParticipatedWindowSummary {
  id: string;
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  computedStatus: EventWindowComputedStatus;
  participantPostVisibility: EventWindowParticipantPostVisibility;
  // UI signal only — the gallery/media endpoints independently re-verify
  // access via ensureCanViewWindowPosts and must not trust this flag.
  canViewPosts: boolean;
  lastParticipatedAt: Date;
}

export interface ParticipatedEventSummary {
  id: string;
  name: string;
  bannerImageKey?: string | null;
  bannerImageDisplay?: EventImageDisplay | null;
  scheduledAt?: Date | null;
  endAt?: Date | null;
  status: string;
  participatedWindows: ParticipatedWindowSummary[];
  lastParticipatedAt: Date;
}

export interface ParticipatedEventsResponse {
  events: ParticipatedEventSummary[];
}
