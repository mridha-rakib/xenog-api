import { z } from "zod";
import { storyMediaSources } from "./story.interface.js";

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
  createStory: z.object({
    body: z
      .object({
        mediaSource: z
          .enum(storyMediaSources, {
            invalid_type_error: "Media source must be camera, gallery, or upload",
          })
          .default("upload"),
        storageKey: z
          .string({
            required_error: "Story video storage key is required",
            invalid_type_error: "Story video storage key must be a string",
          })
          .trim()
          .min(1, "Story video storage key is required")
          .max(300, "Story video storage key cannot exceed 300 characters"),
        contentType: z
          .string({
            required_error: "Story video content type is required",
            invalid_type_error: "Story video content type must be a string",
          })
          .trim()
          .regex(/^video\//i, "Stories must be video files")
          .max(100, "Story video content type cannot exceed 100 characters"),
        durationSeconds: z
          .number({
            required_error: "Story video duration is required",
            invalid_type_error: "Story video duration must be a number",
          })
          .positive("Story video duration must be greater than 0")
          .max(15, "Stories can be up to 15 seconds long"),
        caption: optionalText("Caption", 500),
      })
      .strict(),
  }),
};
