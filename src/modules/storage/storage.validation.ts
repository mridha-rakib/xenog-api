import { z } from "zod";

// Event banner uploads go through this same generic presigned-URL endpoint
// (see app/stores/eventDraftStore.ts buildEventPayload -> uploadFileToStorage,
// which writes to `events/banners/...` and `events/banners/originals/...`).
// Scope the JPEG/PNG-only policy to that key prefix so every other upload
// type (moments, stories, chat, products, etc.) is unaffected.
const EVENT_BANNER_KEY_PREFIX = "events/banners/";
const EVENT_BANNER_ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

const normalizeContentType = (value: string) => {
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "image/jpg" ? "image/jpeg" : base;
};

export const storageValidation = {
  createUploadUrl: z.object({
    body: z
      .object({
        key: z.string().min(1).max(300),
        contentType: z.string().min(1).max(100),
        expiresIn: z.number().int().positive().max(3600).optional(),
      })
      .superRefine((value, ctx) => {
        if (!value.key.startsWith(EVENT_BANNER_KEY_PREFIX)) {
          return;
        }

        if (!EVENT_BANNER_ALLOWED_CONTENT_TYPES.has(normalizeContentType(value.contentType))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Event banner images must be JPEG or PNG.",
            path: ["contentType"],
          });
        }
      }),
  }),
  createDownloadUrl: z.object({
    params: z.object({
      key: z.string().min(1).max(300),
    }),
  }),
  storageKeyQuery: z.object({
    query: z.object({
      key: z.string().min(1).max(300),
      contentType: z.string().min(1).max(100).optional(),
    }),
  }),
};
