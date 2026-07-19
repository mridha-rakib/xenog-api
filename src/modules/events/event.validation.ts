import { z } from "zod";
import {
  eventAgeRestrictions,
  eventCategories,
  eventMediaTypes,
  MAX_EVENT_MEDIA_BATCH_ITEMS,
  MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS,
  eventPriceFilters,
  eventPrivacyOptions,
  eventRewardTypes,
  eventTimePeriods,
  eventTicketTypes,
} from "./event.interface.js";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");
const ticketId = z.string().trim().min(1, "Ticket ID is required").max(80, "Ticket ID cannot exceed 80 characters");
const eventMediaId = z.string().trim().min(1, "Media ID is required").max(80, "Media ID cannot exceed 80 characters");

const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} must be a string` })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => (value === undefined ? undefined : value || null));

const normalizeHashtag = (value: string): string => {
  const normalized = value.normalize("NFKC").trim().replace(/^#+/, "").toLocaleLowerCase();
  return (normalized.match(/^[\p{L}\p{N}_]+/u)?.[0] ?? "").slice(0, 64);
};

const hashtagList = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string") {
      return value.split(/[\s,]+/);
    }

    return value;
  },
  z
    .array(z.string().max(65))
    .max(20)
    .optional()
    .transform((value) => (
      value === undefined
        ? undefined
        : [...new Set(value.map(normalizeHashtag).filter(Boolean))]
    )),
);

const eventDateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const dateTime = (label: string) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") {
        return value;
      }

      const parsed = new Date(value as string | number | Date);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    },
    z.date({
      invalid_type_error: `${label} must be a valid date and time`,
      required_error: `${label} is required`,
    }),
  );

const optionalDateTime = (label: string) =>
  z.preprocess(
    (value) => {
      if (value === undefined) {
        return undefined;
      }

      if (value === null || value === "") {
        return null;
      }

      const parsed = new Date(value as string | number | Date);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    },
    z
      .date({
        invalid_type_error: `${label} must be a valid date and time`,
        required_error: `${label} is required`,
      })
      .nullable()
      .optional(),
  );

const queryNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") {
        return undefined;
      }

      return Number(value);
    },
    schema.optional(),
  );

const eventCategory = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.enum(eventCategories, {
    invalid_type_error: "Category must be one of the predefined event categories",
    required_error: "Category is required",
  }),
);

const optionalEventCategory = eventCategory.optional().nullable().transform((value) => (value === undefined ? undefined : (value ?? null)));

const eventMediaItem = z
  .object({
    type: z.enum(eventMediaTypes),
    storageKey: optionalText("Storage key", 300),
    contentType: optionalText("Content type", 100),
    fileSize: z
      .number({ invalid_type_error: "File size must be a number" })
      .int("File size must be an integer")
      .positive("File size is required")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
    width: z
      .number({ invalid_type_error: "Media width must be a number" })
      .finite("Media width must be finite")
      .min(0, "Media width cannot be negative")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
    height: z
      .number({ invalid_type_error: "Media height must be a number" })
      .finite("Media height must be finite")
      .min(0, "Media height cannot be negative")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
    durationSeconds: z
      .number({ invalid_type_error: "Video duration must be a number" })
      .finite("Video duration must be finite")
      .min(0, "Video duration cannot be negative")
      .max(MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS, "Video duration cannot exceed 10 minutes")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.storageKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storageKey"],
        message: "Event media storage key is required",
      });
    }

    if (!value.contentType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentType"],
        message: "Event media content type is required",
      });
    }

    if (value.type === "image" && value.durationSeconds != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "Image media cannot include video duration",
      });
    }

    if (value.type === "video" && value.durationSeconds == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "Video duration is required",
      });
    }
  });

const eventCategoryList = z
  .array(eventCategory, {
    required_error: "Select at least 1 category",
    invalid_type_error: "Categories must be a list",
  })
  .min(1, "Select at least 1 category")
  .max(3, "You can select up to 3 categories")
  .refine((values) => new Set(values).size === values.length, "Categories must be unique");

const draftEventCategoryList = z
  .array(eventCategory, {
    invalid_type_error: "Categories must be a list",
  })
  .max(3, "You can select up to 3 categories")
  .refine((values) => new Set(values).size === values.length, "Categories must be unique");

const normalizedNumber = z.number().min(0).max(1);

const bannerImageDisplay = z
  .object({
    crop: z
      .object({
        x: normalizedNumber,
        y: normalizedNumber,
        width: normalizedNumber.refine((value) => value > 0, "Crop width is required"),
        height: normalizedNumber.refine((value) => value > 0, "Crop height is required"),
      })
      .strict()
      .refine((value) => value.x + value.width <= 1.001 && value.y + value.height <= 1.001, {
        message: "Crop area must stay inside the image",
      })
      .optional()
      .nullable(),
    imageWidth: z.number().int().positive().optional().nullable(),
    imageHeight: z.number().int().positive().optional().nullable(),
  })
  .strict()
  .optional()
  .nullable()
  .transform((value) => (value === undefined ? undefined : (value ?? null)));

const eventLocation = z
  .object({
    searchLabel: optionalText("Location", 240),
    venue: optionalText("Venue", 160),
    address: optionalText("Address", 240),
    additionalInfo: optionalText("Additional info", 500),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
  })
  .strict();

const eventTicketShape = {
  id: ticketId.optional(),
  name: z.string().trim().min(1, "Ticket name is required").max(120),
  description: optionalText("Ticket description", 1000),
  salesEndAt: z.coerce.date().optional().nullable().transform((value) => value ?? null),
  type: z.enum(eventTicketTypes).default("free"),
  price: z.coerce.number().min(0).max(1_000_000).default(0),
  capacity: z.coerce.number().int().min(0).max(1_000_000),
};

const eventTicket = z
  .object(eventTicketShape)
  .strict()
  .transform((ticket) => ({
    ...ticket,
    price: ticket.type === "free" ? 0 : ticket.price,
  }));

const updateEventTicket = z
  .object({
    name: eventTicketShape.name.optional(),
    description: eventTicketShape.description,
    salesEndAt: eventTicketShape.salesEndAt,
    type: z.enum(eventTicketTypes).optional(),
    price: z.coerce.number().min(0).max(1_000_000).optional(),
    capacity: eventTicketShape.capacity.optional(),
  })
  .strict()
  .refine((ticket) => Object.values(ticket).some((value) => value !== undefined), {
    message: "At least one ticket field is required",
  })
  .transform((ticket) => ({
    ...ticket,
    ...(ticket.type === "free" ? { price: 0 } : {}),
  }));

const eventRewardShape = {
  id: ticketId.optional(),
  rewardType: z.enum(eventRewardTypes),
  ticketId: ticketId.optional().nullable().transform((value) => value ?? null),
  productId: objectId.optional().nullable().transform((value) => value ?? null),
  name: z.string().trim().min(1, "Offer name is required").max(120),
  description: optionalText("Offer description", 1000),
  expiresAt: z.coerce.date().optional().nullable().transform((value) => value ?? null),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  buyQuantity: z.coerce.number().int().min(1).max(1_000_000),
  freeQuantity: z.coerce.number().int().min(1).max(1_000_000),
  capacity: z.coerce.number().int().min(0).max(1_000_000),
};

const validateRewardTarget = <T extends { rewardType?: string; ticketId?: string | null; productId?: string | null }>(
  reward: T,
) => {
  if (reward.rewardType === "ticket") {
    return Boolean(reward.ticketId);
  }

  if (reward.rewardType === "product") {
    return Boolean(reward.productId);
  }

  return true;
};

const eventReward = z
  .object(eventRewardShape)
  .strict()
  .refine(validateRewardTarget, {
    message: "Select a ticket or product for this reward",
  })
  .transform((reward) => ({
    ...reward,
    ticketId: reward.rewardType === "ticket" ? reward.ticketId : null,
    productId: reward.rewardType === "product" ? reward.productId : null,
  }));

const updateEventReward = z
  .object({
    rewardType: z.enum(eventRewardTypes).optional(),
    ticketId: eventRewardShape.ticketId.optional(),
    productId: eventRewardShape.productId.optional(),
    name: eventRewardShape.name.optional(),
    description: eventRewardShape.description,
    expiresAt: eventRewardShape.expiresAt,
    discountPercent: z.coerce.number().min(0).max(100).optional(),
    buyQuantity: eventRewardShape.buyQuantity.optional(),
    freeQuantity: eventRewardShape.freeQuantity.optional(),
    capacity: eventRewardShape.capacity.optional(),
  })
  .strict()
  .refine((reward) => Object.values(reward).some((value) => value !== undefined), {
    message: "At least one reward field is required",
  });

const submitHostReview = z.object({
  liked: z.boolean({
    invalid_type_error: "Review selection is required",
    required_error: "Review selection is required",
  }),
  text: z
    .string({ invalid_type_error: "Review text must be a string" })
    .trim()
    .max(1000, "Review cannot exceed 1000 characters")
    .optional()
    .nullable()
    .transform((value) => (value === undefined ? undefined : value || null)),
}).strict();

const draftBodyBase = z
  .object({
    name: optionalText("Event name", 160),
    description: optionalText("Description", 5000),
    bannerImageKey: optionalText("Banner image", 300),
    bannerOriginalImageKey: optionalText("Original banner image", 300),
    bannerImageDisplay,
    ageRestriction: z.enum(eventAgeRestrictions).optional().nullable(),
    hashtags: hashtagList,
    category: optionalEventCategory,
    categories: draftEventCategoryList.optional(),
    scheduledAt: optionalDateTime("Event start date and time"),
    endAt: optionalDateTime("Event end date and time"),
    location: eventLocation.optional().nullable(),
    tickets: z.array(eventTicket).max(100).optional(),
    privacy: z.enum(eventPrivacyOptions).default("public").optional(),
  })
  .strict();

const validateEventDateRange = (event: { scheduledAt?: Date | null; endAt?: Date | null }, ctx: z.RefinementCtx) => {
  if (event.scheduledAt && event.endAt && event.endAt <= event.scheduledAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Event end date and time must be after the start date and time",
      path: ["endAt"],
    });
  }
};

const validateTicketSalesEndDates = (
  event: { scheduledAt?: Date | null; tickets?: { name?: string; salesEndAt?: Date | null }[] },
  ctx: z.RefinementCtx,
) => {
  if (!event.scheduledAt || !event.tickets?.length) return;

  const now = new Date();

  event.tickets.forEach((ticket, index) => {
    if (!ticket.salesEndAt) return;

    if (ticket.salesEndAt <= now) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Ticket "${ticket.name}" has a sales end date in the past. Update it or remove the sales end date before publishing.`,
        path: ["tickets", index, "salesEndAt"],
      });
    } else if (ticket.salesEndAt > event.scheduledAt!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Ticket "${ticket.name}" sales end date must not be after the event start date and time.`,
        path: ["tickets", index, "salesEndAt"],
      });
    }
  });
};

const draftPatchBody = draftBodyBase.superRefine(validateEventDateRange);

const draftBody = draftBodyBase.superRefine(validateEventDateRange);

const publishBody = draftBodyBase.extend({
  name: z.string().trim().min(1, "Event name is required").max(160),
  ageRestriction: z.enum(eventAgeRestrictions),
  category: eventCategory.optional(),
  categories: eventCategoryList,
  scheduledAt: dateTime("Event start date and time"),
  endAt: dateTime("Event end date and time"),
  location: eventLocation.refine((value) => Boolean(value.venue || value.address || value.searchLabel), {
    message: "Location is required",
  }),
  tickets: z.array(eventTicket).max(100).default([]),
  privacy: z.enum(eventPrivacyOptions).default("public"),
}).superRefine(validateEventDateRange).superRefine(validateTicketSalesEndDates);

const mapQuery = z
  .object({
    category: eventCategory.optional(),
    latitude: queryNumber(z.number().min(-90).max(90)),
    longitude: queryNumber(z.number().min(-180).max(180)),
    radiusKm: queryNumber(z.number().min(1).max(250)),
    north: queryNumber(z.number().min(-90).max(90)),
    south: queryNumber(z.number().min(-90).max(90)),
    east: queryNumber(z.number().min(-180).max(180)),
    west: queryNumber(z.number().min(-180).max(180)),
    cursor: z.string().min(1).optional(),
    limit: queryNumber(z.number().int().min(1).max(200)),
    ageRestriction: z.enum(eventAgeRestrictions).optional(),
    priceFilter: z.enum(eventPriceFilters).optional(),
    date: eventDateKey,
    timePeriod: z.enum(eventTimePeriods).optional(),
    timezoneOffsetMinutes: queryNumber(z.number().int().min(-840).max(840)),
    hashtags: hashtagList,
  })
  .strict()
  .refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
    message: "Latitude and longitude must be provided together",
    path: ["longitude"],
  })
  .refine((query) => {
    const boundValues = [query.north, query.south, query.east, query.west];
    return boundValues.every((value) => value === undefined) || boundValues.every((value) => value !== undefined);
  }, {
    message: "Viewport bounds must include north, south, east, and west",
    path: ["north"],
  })
  .refine((query) => (
    query.north === undefined ||
    query.south === undefined ||
    query.north >= query.south
  ), {
    message: "North must be greater than or equal to south",
    path: ["north"],
  });

const feedQuery = z
  .object({
    category: eventCategory.optional(),
    latitude: queryNumber(z.number().min(-90).max(90)),
    longitude: queryNumber(z.number().min(-180).max(180)),
    radiusKm: queryNumber(z.number().min(1).max(500)),
    limit: queryNumber(z.number().int().min(1).max(200)),
    ageRestriction: z.enum(eventAgeRestrictions).optional(),
    priceFilter: z.enum(eventPriceFilters).optional(),
    date: eventDateKey,
    timePeriod: z.enum(eventTimePeriods).optional(),
    timezoneOffsetMinutes: queryNumber(z.number().int().min(-840).max(840)),
    hashtags: hashtagList,
    audience: z.enum(["discover", "friends"]).optional(),
  })
  .refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
    message: "Latitude and longitude must be provided together",
    path: ["longitude"],
  });

const profileEventsQuery = z.object({
  filter: z.enum(["active", "past", "all"]).optional(),
  page: queryNumber(z.number().int().positive()),
  limit: queryNumber(z.number().int().min(1).max(100)),
});

export const eventValidation = {
  profileEvents: z.object({
    params: z.object({
      userId: objectId,
    }),
    query: profileEventsQuery,
  }),
  eventParams: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  saveDraft: z.object({
    body: draftBody,
  }),
  updateDraft: z.object({
    params: z.object({
      id: objectId,
    }),
    body: draftBody,
  }),
  publish: z.object({
    body: publishBody,
  }),
  publishDraft: z.object({
    params: z.object({
      id: objectId,
    }),
    body: publishBody,
  }),
  updateEvent: z.object({
    params: z.object({
      id: objectId,
    }),
    body: draftPatchBody,
  }),
  deleteEvent: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  eventTicketParams: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
  }),
  eventMediaParams: z.object({
    params: z.object({
      id: objectId,
      mediaId: eventMediaId,
    }),
  }),
  addEventMedia: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z.object({
      mediaItems: z
        .array(eventMediaItem, {
          invalid_type_error: "Event media must be a list",
        })
        .min(1, "Select at least one media item")
        .max(MAX_EVENT_MEDIA_BATCH_ITEMS, `You can upload up to ${MAX_EVENT_MEDIA_BATCH_ITEMS} media items at a time`),
    }),
  }),
  eventRewardParams: z.object({
    params: z.object({
      id: objectId,
      rewardId: ticketId,
    }),
  }),
  createEventTicket: z.object({
    params: z.object({
      id: objectId,
    }),
    body: eventTicket,
  }),
  updateEventTicket: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
    body: updateEventTicket,
  }),
  createDraftTicket: z.object({
    params: z.object({
      id: objectId,
    }),
    body: eventTicket,
  }),
  updateDraftTicket: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
    body: updateEventTicket,
  }),
  deleteDraftTicket: z.object({
    params: z.object({
      id: objectId,
      ticketId,
    }),
  }),
  createEventReward: z.object({
    params: z.object({
      id: objectId,
    }),
    body: eventReward,
  }),
  updateEventReward: z.object({
    params: z.object({
      id: objectId,
      rewardId: ticketId,
    }),
    body: updateEventReward,
  }),
  createDraftReward: z.object({
    params: z.object({
      id: objectId,
    }),
    body: eventReward,
  }),
  updateDraftReward: z.object({
    params: z.object({
      id: objectId,
      rewardId: ticketId,
    }),
    body: updateEventReward,
  }),
  deleteDraftReward: z.object({
    params: z.object({
      id: objectId,
      rewardId: ticketId,
    }),
  }),
  feedEvents: z.object({
    query: feedQuery,
  }),
  mapEvents: z.object({
    query: mapQuery,
  }),
  nowModeEvents: z.object({
    query: mapQuery,
  }),
  claimReward: z.object({
    params: z.object({
      id: objectId,
      rewardId: ticketId,
    }),
  }),
  submitHostReview: z.object({
    params: z.object({
      id: objectId,
    }),
    body: submitHostReview,
  }),
  getEventRewardClaims: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  listEventMembers: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  addEventMember: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z.object({
      userId: objectId,
    }),
  }),
  removeEventMember: z.object({
    params: z.object({
      id: objectId,
      userId: objectId,
    }),
  }),
  adminUserEvents: z.object({
    params: z.object({
      userId: objectId,
    }),
  }),
  submitJoinRequest: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  listJoinRequests: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  joinRequestAction: z.object({
    params: z.object({
      id: objectId,
      requestUserId: objectId,
    }),
  }),
};
