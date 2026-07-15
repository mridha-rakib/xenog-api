import { z } from "zod";
import {
  DEFAULT_EVENT_WINDOW_POST_PAGE_SIZE,
  eventWindowContentTypes,
  eventWindowMediaSources,
  eventWindowMediaTypes,
  MAX_EVENT_WINDOW_POST_PAGE_SIZE,
  MAX_EVENT_WINDOW_POSTS,
} from "./event-window.interface.js";

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");

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
    z.date({
      invalid_type_error: `${label} must be a valid date and time`,
      required_error: `${label} is required`,
    }).optional(),
  );

const optionalText = (label: string, maxLength: number) =>
  z
    .string({ invalid_type_error: `${label} must be a string` })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => (value === undefined ? undefined : value || null));

const allowedContentTypes = z
  .array(z.enum(eventWindowContentTypes), {
    invalid_type_error: "Allowed content types must be a list",
    required_error: "Select at least one allowed content type",
  })
  .min(1, "Select at least one allowed content type")
  .refine((values) => new Set(values).size === values.length, "Allowed content types must be unique");

const validateWindowDateRange = (value: { startsAt?: Date | null; endsAt?: Date | null }, ctx: z.RefinementCtx) => {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Window end date and time must be after the start date and time",
      path: ["endsAt"],
    });
  }
};

const mediaItem = z
  .object({
    type: z.enum(eventWindowMediaTypes),
    source: z.enum(eventWindowMediaSources).default("external"),
    url: optionalText("Media URL", 2000),
    storageKey: optionalText("Storage key", 300),
    contentType: optionalText("Content type", 100),
    durationSeconds: z
      .number({ invalid_type_error: "Media duration must be a number" })
      .finite("Media duration must be finite")
      .min(0, "Media duration cannot be negative")
      .max(60 * 60 * 24, "Media duration cannot exceed 24 hours")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "Event window media must use a storage key",
      });
    }

    if (!value.storageKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storageKey"],
        message: "Event window media storage key is required",
      });
    }
  });

const eventWindowParams = z.object({
  eventId: objectId,
});

const eventWindowPostParams = z.object({
  eventId: objectId,
  windowId: objectId,
});

const eventWindowPostMediaParams = eventWindowPostParams.extend({
  postId: objectId,
  mediaIndex: z.coerce.number().int().min(0).max(9),
});

const listPostsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EVENT_WINDOW_POST_PAGE_SIZE)
    .default(DEFAULT_EVENT_WINDOW_POST_PAGE_SIZE),
  cursor: objectId.optional(),
});

const createWindowBody = z
  .object({
    title: optionalText("Window title", 120),
    details: optionalText("Window details", 500),
    startsAt: dateTime("Window start date and time"),
    endsAt: dateTime("Window end date and time"),
    allowedContentTypes,
    maxPosts: z.coerce.number().int().min(1).max(MAX_EVENT_WINDOW_POSTS),
  })
  .strict()
  .superRefine(validateWindowDateRange);

const updateWindowBody = z
  .object({
    title: optionalText("Window title", 120),
    details: optionalText("Window details", 500),
    startsAt: optionalDateTime("Window start date and time"),
    endsAt: optionalDateTime("Window end date and time"),
    allowedContentTypes: allowedContentTypes.optional(),
    maxPosts: z.coerce.number().int().min(1).max(MAX_EVENT_WINDOW_POSTS).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "At least one window field is required",
  })
  .superRefine(validateWindowDateRange);

const createPostBody = z
  .object({
    contentType: z.enum(eventWindowContentTypes),
    text: optionalText("Text", 5000),
    mediaItems: z.array(mediaItem).max(10).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contentType === "text") {
      if (!value.text) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "Text is required for a text post",
        });
      }
      return;
    }

    if (value.mediaItems.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaItems"],
        message: "Media is required for this post type",
      });
      return;
    }

    if (value.mediaItems.some((item) => item.type !== value.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaItems"],
        message: "Media item type must match the post content type",
      });
    }
  });

export const eventWindowValidation = {
  eventWindowParams: z.object({
    params: eventWindowParams,
  }),
  eventWindowPostParams: z.object({
    params: eventWindowPostParams,
  }),
  eventWindowPostMediaParams: z.object({
    params: eventWindowPostMediaParams,
  }),
  createWindow: z.object({
    params: eventWindowParams,
    body: createWindowBody,
  }),
  updateWindow: z.object({
    params: eventWindowPostParams,
    body: updateWindowBody,
  }),
  createPost: z.object({
    params: eventWindowPostParams,
    body: createPostBody,
  }),
  listPosts: z.object({
    params: eventWindowPostParams,
    query: listPostsQuery,
  }),
};
