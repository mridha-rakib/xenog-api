import { z } from "zod";
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
      .max(60 * 60 * 24, "Media duration cannot exceed 24 hours")
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
  });

export const momentValidation = {
  momentIdParam: z.object({
    params: z.object({
      id: objectId,
    }),
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
        eventTitle: optionalText("Event", 200),
        eventId: objectId.optional().nullable(),
        eventCode: optionalText("Event code", 200),
        mediaItems: z
          .array(mediaItem, {
            invalid_type_error: "Media items must be an array",
          })
          .max(10, "You cannot attach more than 10 media items")
          .default([]),
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
