import { z } from "zod";
import { storyMediaSources, storyMediaTypes } from "./story.interface.js";

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

export const storyValidation = {
  storyId: z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid story id") }) }),
  userId: z.object({ params: z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid user id") }) }),
  createComment: z.object({
    params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid story id") }),
    body: z.object({
      text: z.string().trim().min(1).max(2000),
      parentCommentId: z.string().regex(/^[a-f\d]{24}$/i).optional().nullable(),
    }).strict(),
  }),
  shareStory: z.object({
    params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid story id") }),
    body: z.object({
      caption: optionalText("Repost caption", 2000),
      taggedFriendIds: z.array(z.string().regex(/^[a-f\d]{24}$/i, "Invalid tagged friend id")).max(20).optional(),
      clientRequestId: optionalText("Client request id", 120),
    }).strict(),
  }),
  createStory: z.object({
    body: z
      .object({
        mediaType: z
          .enum(storyMediaTypes, {
            invalid_type_error: "Media type must be image, video, or text",
          })
          .default("video"),
        mediaSource: z
          .enum(storyMediaSources, {
            invalid_type_error: "Media source must be camera, gallery, or upload",
          })
          .default("upload"),
        storageKey: z
          .string({
            invalid_type_error: "Story storage key must be a string",
          })
          .trim()
          .min(1, "Story storage key is required")
          .max(300, "Story storage key cannot exceed 300 characters")
          .optional()
          .nullable(),
        contentType: z
          .string({
            invalid_type_error: "Story content type must be a string",
          })
          .trim()
          .max(100, "Story content type cannot exceed 100 characters")
          .optional()
          .nullable(),
        durationSeconds: z
          .number({
            required_error: "Story duration is required",
            invalid_type_error: "Story duration must be a number",
          })
          .positive("Story duration must be greater than 0")
          .max(15, "Stories can be up to 15 seconds long"),
        caption: optionalText("Caption", 500),
        textContent: optionalText("Story text", 500),
        textBackground: z
          .object({
            type: z.enum(["color", "gradient"]).default("color"),
            colors: z
              .array(z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "Background colors must be hex colors"))
              .min(1, "At least one background color is required")
              .max(2, "A story background can use up to 2 colors"),
          })
          .optional()
          .nullable(),
        textOverlay: z
          .object({
            text: z.string().trim().min(1, "Overlay text is required").max(160, "Overlay text cannot exceed 160 characters"),
            x: z.number().min(0).max(1).default(0.5),
            y: z.number().min(0).max(1).default(0.5),
            scale: z.number().min(0.5).max(2).default(1),
            color: z.string().trim().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "Overlay color must be a hex color").default("#FFFFFF"),
            fontWeight: z.enum(["normal", "600", "700", "bold"]).default("700"),
            textAlign: z.enum(["left", "center", "right"]).default("center"),
          })
          .optional()
          .nullable(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.mediaType === "text") {
          if (!value.textContent) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["textContent"],
              message: "Story text is required",
            });
          }
          return;
        }

        if (!value.storageKey) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["storageKey"],
            message: "Story storage key is required",
          });
        }

        if (!value.contentType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contentType"],
            message: "Story content type is required",
          });
          return;
        }

        if (value.mediaType === "image" && !value.contentType.toLowerCase().startsWith("image/")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contentType"],
            message: "Image stories must use image files",
          });
        }

        if (value.mediaType === "video" && !value.contentType.toLowerCase().startsWith("video/")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contentType"],
            message: "Video stories must use video files",
          });
        }
      }),
  }),
};
