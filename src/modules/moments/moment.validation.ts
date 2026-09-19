import { z } from "zod";
import { env } from "../../config/env.js";
import { momentAudiences, momentMediaSources, momentMediaTypes, momentModes } from "./moment.interface.js";

const objectId = z
  .string({
    invalid_type_error: "ID must be a string",
  })
  .regex(/^[a-f\d]{24}$/i, "ID must be a valid object id");

const optionalText = (label: string, maxLength: number) =>
  z
    .string({
      invalid_type_error: `${label} must be a string`,
    })
    .trim()
    .max(maxLength, `${label} cannot exceed ${maxLength} characters`)
    .optional()
    .nullable()
    .transform((value) => value || null);

const audience = z
  .union([
    z.enum(momentAudiences),
    z.enum(["Public", "Friends", "Only Me"]),
  ])
  .transform((value) => {
    if (value === "Public") {
      return "public";
    }

    if (value === "Friends") {
      return "friends";
    }

    if (value === "Only Me") {
      return "only_me";
    }

    return value;
  });

// CRT-011 media policy — mirrors app/post-screen/create-post.tsx's
// APPROVED_IMAGE_MIME_TYPES / APPROVED_AUDIO_MIME_TYPES /
// AUDIO_MIN_DURATION_SECONDS / AUDIO_MAX_DURATION_SECONDS exactly, so a file
// the client accepts can never be rejected here and vice versa. File-size
// limits (15 MB/image, 20 MB/audio, 50 MB total) are deliberately NOT
// enforced at this layer: MomentMediaItem's `fileSize` field is not part of
// the create payload contract today, and adding it would mean threading a
// new field through several client call sites (recorder/picker callback
// signatures) — a materially bigger change than this validation task calls
// for. Those size limits are therefore client-enforced only; see the CRT-011
// media-policy report for the explicit trust-boundary note.
const MOMENT_IMAGE_APPROVED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MOMENT_AUDIO_APPROVED_CONTENT_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);
const MOMENT_AUDIO_MIN_DURATION_SECONDS = 1;
const MOMENT_AUDIO_MAX_DURATION_SECONDS = 5 * 60;

const normalizeMomentMimeType = (value?: string | null): string => (
  (value ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? ""
);

const mediaItem = z
  .object({
    type: z.enum(momentMediaTypes, {
      required_error: "Media type is required",
      invalid_type_error: "Media type must be image, video, or audio",
    }),
    source: z
      .enum(momentMediaSources, {
        invalid_type_error: "Media source must be gallery, camera, upload, or external",
      })
      .default("external"),
    url: optionalText("Media URL", 2000),
    storageKey: optionalText("Storage key", 300),
    contentType: optionalText("Content type", 100),
    durationSeconds: z
      .number({
        invalid_type_error: "Media duration must be a number",
      })
      .finite("Media duration must be finite")
      .min(0, "Media duration cannot be negative")
      .optional()
      .nullable()
      .transform((value) => value ?? null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.url && !value.storageKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "A media URL or storage key is required",
      });
    }

    if (value.type === "video" && value.durationSeconds !== null && value.durationSeconds > env.MOMENT_VIDEO_MAX_DURATION_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "Create Post videos can be up to 1 minute",
      });
    }

    if (value.type !== "video" && value.contentType?.toLowerCase().trim().startsWith("video/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: "Video files must be submitted as video media",
      });
    }

    // CRT-011: only validated when contentType is actually present — this
    // stays additive/non-breaking for any existing record or caller that
    // omits it, rather than newly requiring the field.
    if (value.type === "image" && value.contentType
      && !MOMENT_IMAGE_APPROVED_CONTENT_TYPES.has(normalizeMomentMimeType(value.contentType))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentType"],
        message: "Choose a JPEG, PNG, or WebP image",
      });
    }

    if (value.type === "audio") {
      if (value.contentType && !MOMENT_AUDIO_APPROVED_CONTENT_TYPES.has(normalizeMomentMimeType(value.contentType))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contentType"],
          message: "Choose an M4A, AAC, MP3, WAV, or OGG file",
        });
      }

      if (value.durationSeconds !== null) {
        if (value.durationSeconds < MOMENT_AUDIO_MIN_DURATION_SECONDS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["durationSeconds"],
            message: "Audio must be at least 1 second",
          });
        } else if (value.durationSeconds > MOMENT_AUDIO_MAX_DURATION_SECONDS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["durationSeconds"],
            message: "Audio can be up to 5 minutes",
          });
        }
      }
    }
  });

export const momentValidation = {
  createVideoUpload: z.object({
    body: z.object({
      contentType: z
        .string({
          required_error: "Content type is required",
          invalid_type_error: "Content type must be a string",
        })
        .trim()
        .min(1, "Content type is required")
        .max(100, "Content type cannot exceed 100 characters"),
    }).strict(),
  }),
  uploadVideo: z.object({
    query: z.object({
      key: z
        .string({
          required_error: "Storage key is required",
          invalid_type_error: "Storage key must be a string",
        })
        .trim()
        .min(1, "Storage key is required")
        .max(300, "Storage key cannot exceed 300 characters"),
      contentType: z
        .string({
          invalid_type_error: "Content type must be a string",
        })
        .trim()
        .max(100, "Content type cannot exceed 100 characters")
        .optional(),
    }).strict(),
  }),
  feedShares: z.object({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      audience: z.enum(["discover", "friends"]).optional(),
    }).strict(),
  }),
  feedQuery: z.object({
    query: z.object({
      hashtags: z
        .string()
        .max(1300)
        .optional()
        .transform((value) => value
          ? [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 20)
          : []),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      audience: z.enum(["discover", "friends"]).optional(),
      latitude: z.coerce.number().min(-90).max(90).optional(),
      longitude: z.coerce.number().min(-180).max(180).optional(),
      radiusKm: z.coerce.number().finite().positive().optional(),
    }).strict().refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
      message: "Latitude and longitude must be provided together",
      path: ["longitude"],
    }),
  }),
  hashtagMoments: z.object({
    params: z.object({
      hashtag: z.string().trim().min(1).max(65),
    }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(100),
      // Search screen only: also return a small, capped prefix/morphology-variant
      // tag group. Absent (hashtag detail screen) => unchanged exact-tag behaviour.
      expand: z.literal("1").optional(),
      // Hashtag detail screen pagination (exact-tag only). `paginate=1` opts the
      // response into cursor mode (adds `nextCursor`); `cursor` continues a page.
      paginate: z.literal("1").optional(),
      cursor: z.string().min(1).max(500).optional(),
    }).strict(),
  }),
  momentIdParam: z.object({
    params: z.object({
      id: objectId,
    }),
  }),
  updateMoment: z.object({
    params: z.object({ id: objectId }),
    body: z.object({
      caption: optionalText("Caption", 5000),
    }).strict(),
  }),
  shareMoment: z.object({
    params: z.object({ id: objectId }),
    body: z.object({
      caption: optionalText("Repost caption", 2000),
      taggedFriendIds: z.array(objectId).max(20).default([]).transform((ids) => [...new Set(ids)]),
      clientRequestId: z.string().trim().min(8).max(100).regex(/^[a-zA-Z0-9._:-]+$/).optional().nullable(),
    }).strict(),
  }),
  updateMomentShare: z.object({
    params: z.object({ shareId: objectId }),
    body: z.object({
      caption: optionalText("Repost caption", 2000),
      taggedFriendIds: z.array(objectId).max(20).transform((ids) => [...new Set(ids)]).optional(),
    }).strict(),
  }),
  commentReaction: z.object({
    params: z.object({
      id: objectId,
      commentId: objectId,
    }),
  }),
  eventMoments: z.object({
    params: z.object({
      eventId: objectId,
    }),
  }),
  profileTimeline: z.object({
    params: z.object({
      userId: objectId,
    }),
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  createComment: z.object({
    params: z.object({
      id: objectId,
    }),
    body: z
      .object({
        text: z
          .string({
            required_error: "Comment text is required",
            invalid_type_error: "Comment text must be a string",
          })
          .trim()
          .min(1, "Comment text is required")
          .max(2000, "Comment cannot exceed 2000 characters"),
        parentCommentId: objectId.optional().nullable(),
      })
      .strict(),
  }),
  createMoment: z.object({
    body: z
      .object({
        mode: z.enum(momentModes, {
          required_error: "Moment type is required",
          invalid_type_error: "Moment type must be feed or event",
        }),
        caption: optionalText("Caption", 5000),
        audience: audience.default("public"),
        taggedPeople: z
          .array(
            z
              .string({
                invalid_type_error: "Tagged person must be a string",
              })
              .trim()
              .min(1, "Tagged person is required")
              .max(120, "Tagged person cannot exceed 120 characters"),
            {
              invalid_type_error: "Tagged people must be an array",
            },
          )
          .max(50, "You cannot tag more than 50 people")
          .default([])
          .transform((names) => [...new Set(names)]),
        taggedFriendIds: z.array(objectId).max(50).default([]).transform((ids) => [...new Set(ids)]),
        eventTitle: optionalText("Event", 200),
        eventId: objectId.optional().nullable(),
        eventCode: optionalText("Event code", 200),
        mediaItems: z
          .array(mediaItem, {
            invalid_type_error: "Media items must be an array",
          })
          .max(10, "You cannot attach more than 10 media items")
          .default([]),
        // CRT-012: optional, client-generated, opaque retry-idempotency key.
        // Same format/limits as shareMoment's clientRequestId above so a
        // stale/legacy client omitting it entirely is unaffected.
        clientRequestId: z.string().trim().min(8).max(100).regex(/^[a-zA-Z0-9._:-]+$/).optional().nullable(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (!value.caption && value.mediaItems.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["caption"],
            message: "Write a stitch or attach media before creating a moment",
          });
        }

        if (value.mode === "event" && !value.eventTitle && !value.eventCode) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["eventTitle"],
            message: "Select or scan an event before creating an event moment",
          });
        }
      }),
  }),
};
