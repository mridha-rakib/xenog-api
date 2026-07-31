import type { Types } from "mongoose";
import type { EventHostReviewEligibilityResponse } from "./event-host-review.interface.js";
import type { PublicEventGoingSummaryResponse } from "../payments/checkout-payment.interface.js";
import type { EventCancellationReasonType } from "../payments/event-cancellation-refund.interface.js";

export const eventStatuses = ["draft", "published", "live", "completed", "cancelled"] as const;
export type EventStatus = (typeof eventStatuses)[number];
export const crowdStatuses = ["not_busy", "busy", "very_busy"] as const;
export type CrowdStatus = (typeof crowdStatuses)[number];

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

export const eventCategoryMetadata = [
  {
    value: "Parties & Celebrations",
    displayName: "Parties & Celebrations",
    order: 1,
    emoji: "🎉",
    solidColorName: "Hot Pink",
    hexColor: "#FF1493",
    purpose: "Bright, high-saturation neon pink. Ideal for birthdays, engagements, and personal celebrations.",
  },
  {
    value: "Nightlife & Clubs",
    displayName: "Nightlife & Clubs",
    order: 2,
    emoji: "🍻",
    solidColorName: "Deep Purple",
    hexColor: "#8A2BE2",
    purpose: "Rich, vibrant violet. No pink undertones. For late-night events, DJ sets, and clubbing.",
  },
  {
    value: "Social Meetups",
    displayName: "Social Meetups",
    order: 3,
    emoji: "💬",
    solidColorName: "Cyan",
    hexColor: "#00F0FF",
    purpose: "Glowing, electric light blue. Perfect for casual hangouts, mixer events, and meeting new people.",
  },
  {
    value: "College & Campus",
    displayName: "College & Campus",
    order: 4,
    emoji: "🎓",
    solidColorName: "Electric Blue",
    hexColor: "#1F51FF",
    purpose: "High-luminance neon blue. Highly distinct from Cyan and Navy, popping brightly against dark backgrounds.",
  },
  {
    value: "Live Music & Concerts",
    displayName: "Live Music & Concerts",
    order: 5,
    emoji: "🎸",
    solidColorName: "Bright Orange",
    hexColor: "#FF6B00",
    purpose: "Vivid, fiery orange. Highly energetic. For live gigs, festivals, and music sessions.",
  },
  {
    value: "Entertainment & Shows",
    displayName: "Entertainment & Shows",
    order: 6,
    emoji: "🎭",
    solidColorName: "Ruby Red",
    hexColor: "#E50914",
    purpose: "High-impact, pure theater-curtain red. For comedy nights, cinema, plays, and performances.",
  },
  {
    value: "Arts & Culture",
    displayName: "Arts & Culture",
    order: 7,
    emoji: "🎨",
    solidColorName: "Plum / Mauve",
    hexColor: "#DDA0DD",
    purpose: "A soft, light orchid-plum. Shifted lighter to differentiate clearly from Deep Purple and Hot Pink.",
  },
  {
    value: "Community & Movements",
    displayName: "Community & Movements",
    order: 8,
    emoji: "✊",
    solidColorName: "Burgundy",
    hexColor: "#580F24",
    purpose: "Dark, warm wine-red. For neighborhood initiatives, social drives, volunteering, and collective action.",
  },
  {
    value: "Food & Drinks",
    displayName: "Food & Drinks",
    order: 9,
    emoji: "🍹",
    solidColorName: "Golden Yellow",
    hexColor: "#FFC700",
    purpose: "Warm, golden amber yellow. Now includes dining experiences, food festivals, wine tastings, and brunches.",
  },
  {
    value: "Markets & Shopping",
    displayName: "Markets & Shopping",
    order: 10,
    emoji: "🛍️",
    solidColorName: "Coral",
    hexColor: "#FF7F50",
    purpose: "Muted, friendly pink-orange pastel. For flea markets, clothing swaps, thrift events, and craft fairs.",
  },
  {
    value: "Sports & Outdoors",
    displayName: "Sports & Outdoors",
    order: 11,
    emoji: "🏃",
    solidColorName: "Emerald Green",
    hexColor: "#00A86B",
    purpose: "Pure, deep grass and turf green. For group hikes, recreational sports, workouts, and outdoor activities.",
  },
  {
    value: "Games & Recreation",
    displayName: "Games & Recreation",
    order: 12,
    emoji: "🎮",
    solidColorName: "Lime Green",
    hexColor: "#39FF14",
    purpose: "Ultra-bright, neon yellow-green. For board game nights, trivia, esports, and arcades. Distinct from Emerald.",
  },
  {
    value: "Workshops & Classes",
    displayName: "Workshops & Classes",
    order: 13,
    emoji: "🧶",
    solidColorName: "Bronze Brown",
    hexColor: "#8B5A2B",
    purpose: "Rich, warm, earthy bronze. For hands-on learning, pottery, cooking classes, and skill-building.",
  },
  {
    value: "Conferences & Talks",
    displayName: "Conferences & Talks",
    order: 14,
    emoji: "🎤",
    solidColorName: "Slate Gray",
    hexColor: "#708090",
    purpose: "Neutral, highly professional metallic gray-blue. For professional panels, guest speakers, seminars, and networking.",
  },
  {
    value: "Family & Gathering",
    displayName: "Family & Gathering",
    order: 15,
    emoji: "🏡",
    solidColorName: "Mint Green",
    hexColor: "#AAF0D1",
    purpose: "Pale, welcoming pastel mint. Highly distinct from deep Emerald and neon Lime. For family-friendly meetups and gatherings.",
  },
  {
    value: "Wellness & Spirituality",
    displayName: "Wellness & Spirituality",
    order: 16,
    emoji: "🧘",
    solidColorName: "Silver Grey",
    hexColor: "#C0C0C0",
    purpose: "A soft, balanced metallic silver-grey. Ensures high visibility on a pure white background while remaining clean and neutral.",
  },
  {
    value: "Travel & Experiences",
    displayName: "Travel & Experiences",
    order: 17,
    emoji: "✈️",
    solidColorName: "Teal",
    hexColor: "#008080",
    purpose: "Rich, saturated blue-green. For day trips, local tours, excursions, and group travel adventures.",
  },
  {
    value: "Pop-Ups & Exclusives",
    displayName: "Pop-Ups & Exclusives",
    order: 18,
    emoji: "✨",
    solidColorName: "Gold",
    hexColor: "#D4AF37",
    purpose: "Sophisticated, metallic champagne-gold. For hype limited-run events, fashion pop-ups, and special-edition collaborations.",
  },
] as const;
export type EventCategoryMetadata = (typeof eventCategoryMetadata)[number];
export type EventCategory = EventCategoryMetadata["value"];
export const eventCategories = eventCategoryMetadata.map((category) => category.value) as [EventCategory, ...EventCategory[]];

export interface EventLocation {
  searchLabel?: string | null;
  venue?: string | null;
  address?: string | null;
  formattedAddress?: string | null;
  addressLine1?: string | null;
  neighborhood?: string | null;
  district?: string | null;
  city?: string | null;
  region?: string | null;
  regionCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
  additionalInfo?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  mapboxPlaceId?: string | null;
  locationProvider?: string | null;
  providerResultType?: string | null;
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
  availableCount?: number | null;
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
  cancellationReasonType?: EventCancellationReasonType | null;
  cancellationCustomReason?: string | null;
  cancellationDisplayReason?: string | null;
  refundBatchId?: Types.ObjectId | null;
  cancellationOperationId?: string | null;
  cancellationWorkflowVersion?: number | null;
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
  crowdStatus: CrowdStatus | null;
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
  cancellationReasonType?: EventCancellationReasonType | null;
  cancellationCustomReason?: string | null;
  cancellationDisplayReason?: string | null;
  refundBatchId?: string | null;
  cancellationOperationId?: string | null;
  cancellationWorkflowVersion?: number | null;
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
  crowdStatus: CrowdStatus | null;
  scheduledAt?: Date | null;
  endAt?: Date | null;
  latitude: number;
  longitude: number;
  locationName: string;
  category?: EventCategory | null;
  categories: EventCategory[];
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
