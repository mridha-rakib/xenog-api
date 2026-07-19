import type { Types } from "mongoose";
import type { EventHostReviewEligibilityResponse } from "./event-host-review.interface.js";
import type { PublicEventGoingSummaryResponse } from "../payments/checkout-payment.interface.js";

export const eventStatuses = ["draft", "published", "live", "completed", "cancelled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const eventAgeRestrictions = ["all_ages", "18_plus", "21_plus"] as const;
export type EventAgeRestriction = (typeof eventAgeRestrictions)[number];

export const eventPrivacyOptions = ["public", "locked", "private"] as const;
export type EventPrivacy = (typeof eventPrivacyOptions)[number];

export const eventTicketTypes = ["free", "pay"] as const;
export type EventTicketType = (typeof eventTicketTypes)[number];

export const eventPriceFilters = ["free", "lt_10", "lt_50", "lt_100", "gte_100"] as const;
export type EventPriceFilter = (typeof eventPriceFilters)[number];

export const eventTimePeriods = ["morning", "noon", "evening", "late_night", "any"] as const;
export type EventTimePeriod = (typeof eventTimePeriods)[number];

export const eventRewardTypes = ["ticket", "product"] as const;
export type EventRewardType = (typeof eventRewardTypes)[number];

export const eventJoinRequestStatuses = ["pending", "accepted", "declined"] as const;
export type EventJoinRequestStatus = (typeof eventJoinRequestStatuses)[number];

export const eventMediaTypes = ["image", "video"] as const;
export type EventMediaType = (typeof eventMediaTypes)[number];

export const MAX_EVENT_MEDIA_ITEMS = 30;
export const MAX_EVENT_MEDIA_BATCH_ITEMS = 5;
export const MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS = 10 * 60;
export const EVENT_MEDIA_LIMITS_BYTES = {
  image: 15 * 1024 * 1024,
  video: 300 * 1024 * 1024,
} as const satisfies Record<EventMediaType, number>;

export const supportedEventImageContentTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const supportedEventVideoContentTypes = ["video/mp4", "video/quicktime"] as const;

export interface EventJoinRequest {
  userId: Types.ObjectId;
  status: EventJoinRequestStatus;
  createdAt: Date;
}

export const eventCategories = [
  "Music",
  "Nightlife",
  "Shows & Entertainment",
  "Food & Drinks",
  "Dining Experiences",
  "Food Trucks",
  "Social Meetups",
  "Social Pop-ups",
  "Sports & Outdoor",
  "Games & Leisure",
  "Learning & Classes",
  "Markets & Trade",
  "Street Performances",
  "Religious & Spiritual",
  "College Events",
  "Premium Experiences",
  "Family & Community",
  "Other",
] as const;
export type EventCategory = (typeof eventCategories)[number];

export interface EventLocation {
  searchLabel?: string | null;
  venue?: string | null;
  address?: string | null;
  additionalInfo?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface EventTicket {
  id: string;
  name: string;
  description?: string | null;
  salesEndAt?: Date | null;
  type: EventTicketType;
  price: number;
  capacity: number;
  availableCount: number | null;
}

export type EventTicketInput = Omit<EventTicket, "id" | "availableCount"> & {
  id?: string;
};

export interface EventReward {
  id: string;
  rewardType: EventRewardType;
  ticketId?: string | null;
  productId?: Types.ObjectId | string | null;
  targetName?: string | null;
  imageKeys?: string[];
  name: string;
  description?: string | null;
  expiresAt?: Date | null;
  discountPercent: number;
  buyQuantity: number;
  freeQuantity: number;
  capacity: number;
}

export type EventRewardInput = Omit<EventReward, "id" | "productId"> & {
  id?: string;
  productId?: Types.ObjectId | string | null;
};

export interface EventMediaItem {
  id: string;
  storageKey: string;
  type: EventMediaType;
  contentType: string;
  fileSize: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  uploaderId: Types.ObjectId;
  displayOrder: number;
  createdAt: Date;
}

export type EventMediaInput = Omit<EventMediaItem, "id" | "uploaderId" | "displayOrder" | "createdAt"> & {
  id?: string;
  fileSize?: number | null;
};

export interface EventMediaResponse {
  id: string;
  url: string;
  type: EventMediaType;
  contentType: string;
  fileSize: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  uploaderId: string;
  displayOrder: number;
  createdAt: Date;
}

export interface AddEventMediaDto {
  mediaItems: EventMediaInput[];
}

export type AddEventMediaFailure = {
  index: number;
  message: string;
};

export interface AddEventMediaResponse {
  event: EventResponse;
  mediaItems: EventMediaResponse[];
  failures: AddEventMediaFailure[];
}

export interface DeleteEventMediaResponse {
  event: EventResponse;
  mediaItem: EventMediaResponse;
}

export interface EventImageDisplay {
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
}

export interface EventHostResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  followersCount?: number;
  eventsCount?: number;
  isFollowing?: boolean;
}

export interface EventMemberResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface JoinRequestResponse {
  userId: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  status: EventJoinRequestStatus;
  createdAt: string;
}

export interface IEvent {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: EventStatus;
  name?: string | null;
  description?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  bannerImageDisplay?: EventImageDisplay | null;
  ageRestriction?: EventAgeRestriction | null;
  hashtags?: string[];
  category?: EventCategory | null;
  categories?: EventCategory[];
  scheduledAt?: Date | null;
  endAt?: Date | null;
  location?: EventLocation | null;
  tickets: EventTicket[];
  rewards: EventReward[];
  eventMedia: EventMediaItem[];
  privacy: EventPrivacy;
  memberUserIds: Types.ObjectId[];
  joinRequests: EventJoinRequest[];
  publishedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveEventDraftDto {
  name?: string | null;
  description?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  bannerImageDisplay?: EventImageDisplay | null;
  ageRestriction?: EventAgeRestriction | null;
  hashtags?: string[];
  category?: EventCategory | null;
  categories?: EventCategory[];
  scheduledAt?: Date | null;
  endAt?: Date | null;
  location?: EventLocation | null;
  tickets?: EventTicketInput[];
  rewards?: EventRewardInput[];
  privacy?: EventPrivacy;
}

export type CreateEventTicketDto = EventTicketInput;
export type UpdateEventTicketDto = Partial<Omit<EventTicketInput, "id">>;
export type CreateEventRewardDto = EventRewardInput;
export type UpdateEventRewardDto = Partial<Omit<EventRewardInput, "id">>;

export interface PublishEventDto extends SaveEventDraftDto {
  name: string;
  description?: string | null;
  ageRestriction: EventAgeRestriction;
  categories: EventCategory[];
  scheduledAt: Date;
  endAt: Date;
  location: EventLocation;
  tickets: EventTicketInput[];
  rewards?: EventRewardInput[];
  privacy: EventPrivacy;
}

export interface EventResponse {
  id: string;
  userId: string;
  host?: EventHostResponse | null;
  interactionMomentId?: string;
  likesCount?: number;
  commentsCount?: number;
  sharesCount?: number;
  isLiked?: boolean;
  isSaved?: boolean;
  canReport?: boolean;
  status: EventStatus;
  name?: string | null;
  description?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  bannerImageDisplay?: EventImageDisplay | null;
  ageRestriction?: EventAgeRestriction | null;
  hashtags?: string[];
  category?: EventCategory | null;
  categories: EventCategory[];
  scheduledAt?: Date | null;
  endAt?: Date | null;
  location?: EventLocation | null;
  tickets: EventTicket[];
  rewards: EventReward[];
  eventMedia?: EventMediaResponse[];
  privacy: EventPrivacy;
  memberCount?: number;
  isMember?: boolean;
  myJoinRequestStatus?: EventJoinRequestStatus | null;
  hostReviewEligibility?: EventHostReviewEligibilityResponse;
  publicGoingSummary?: PublicEventGoingSummaryResponse;
  publishedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileEventGroupsResponse {
  active: EventResponse[];
  past: EventResponse[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type ProfileEventFilter = "active" | "past" | "all";

export interface ProfileEventsQuery {
  filter?: ProfileEventFilter;
  page?: number;
  limit?: number;
}

export interface EventMapQuery {
  category?: EventCategory;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  north?: number;
  south?: number;
  east?: number;
  west?: number;
  cursor?: string;
  limit?: number;
  ageRestriction?: EventAgeRestriction;
  priceFilter?: EventPriceFilter;
  date?: string;
  timePeriod?: EventTimePeriod;
  timezoneOffsetMinutes?: number;
  hashtags?: string[];
}

export interface EventMapPaginationCursor {
  scheduledAt: Date;
  publishedAt: Date;
  id: string;
}

export interface EventMapListResponse {
  events: EventResponse[];
  nextCursor?: string | null;
}

export type AdminMapEventStatus = "upcoming" | "live" | "active";

export interface AdminMapEventResponse {
  id: string;
  title: string;
  status: AdminMapEventStatus;
  scheduledAt?: Date | null;
  endAt?: Date | null;
  latitude: number;
  longitude: number;
  locationName: string;
  category?: EventCategory | null;
  bannerImageUrl?: string | null;
  hostName?: string | null;
}

export interface EventFeedQuery {
  category?: EventCategory;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
  ageRestriction?: EventAgeRestriction;
  priceFilter?: EventPriceFilter;
  date?: string;
  timePeriod?: EventTimePeriod;
  timezoneOffsetMinutes?: number;
  hashtags?: string[];
  audience?: "discover" | "friends";
}

export interface RewardClaimResponse {
  id: string;
  userId: string;
  eventId: string;
  rewardId: string;
  claimedAt: Date;
  createdAt: Date;
}

export type NowEventStatus = "live_now" | "starting_soon" | "last_call";

export interface NowModeQuery {
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
}

export interface NowModeEventResponse extends EventResponse {
  nowStatus: NowEventStatus;
}

export type PostTagEventStatus = "live" | "active" | "upcoming";

export interface PostTagEventResponse {
  id: string;
  name: string;
  bannerImageUrl?: string | null;
  scheduledAt: Date;
  location?: EventLocation | null;
  postTagStatus: PostTagEventStatus;
}

export interface TicketAccessResponse {
  hasAccess: boolean;
}
