import type { Types } from "mongoose";

export const eventStatuses = ["draft", "published"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const eventAgeRestrictions = ["all_ages", "18_plus", "21_plus"] as const;
export type EventAgeRestriction = (typeof eventAgeRestrictions)[number];

export const eventPrivacyOptions = ["public", "private"] as const;
export type EventPrivacy = (typeof eventPrivacyOptions)[number];

export const eventTicketTypes = ["free", "pay"] as const;
export type EventTicketType = (typeof eventTicketTypes)[number];

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
  "Sheet Performances",
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
}

export type EventTicketInput = Omit<EventTicket, "id"> & {
  id?: string;
};

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
  category?: EventCategory | null;
  scheduledAt?: Date | null;
  location?: EventLocation | null;
  tickets: EventTicket[];
  privacy: EventPrivacy;
  publishedAt?: Date | null;
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
  category?: EventCategory | null;
  scheduledAt?: Date | null;
  location?: EventLocation | null;
  tickets?: EventTicketInput[];
  privacy?: EventPrivacy;
}

export type CreateEventTicketDto = EventTicketInput;
export type UpdateEventTicketDto = Partial<Omit<EventTicketInput, "id">>;

export interface PublishEventDto extends SaveEventDraftDto {
  name: string;
  description?: string | null;
  ageRestriction: EventAgeRestriction;
  category: EventCategory;
  scheduledAt: Date;
  location: EventLocation;
  tickets: EventTicketInput[];
  privacy: EventPrivacy;
}

export interface EventResponse {
  id: string;
  userId: string;
  host?: EventHostResponse | null;
  status: EventStatus;
  name?: string | null;
  description?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  bannerImageDisplay?: EventImageDisplay | null;
  ageRestriction?: EventAgeRestriction | null;
  category?: EventCategory | null;
  scheduledAt?: Date | null;
  location?: EventLocation | null;
  tickets: EventTicket[];
  privacy: EventPrivacy;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileEventGroupsResponse {
  active: EventResponse[];
  past: EventResponse[];
}

export interface EventMapQuery {
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
}
