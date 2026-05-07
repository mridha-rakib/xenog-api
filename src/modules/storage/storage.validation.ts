import { z } from "zod";

export const storageValidation = {
  createUploadUrl: z.object({
    body: z.object({
      key: z.string().min(1).max(300),
      contentType: z.string().min(1).max(100),
      expiresIn: z.number().int().positive().max(3600).optional(),
    }),
  }),
  createDownloadUrl: z.object({
    params: z.object({
      key: z.string().min(1).max(300),
    }),
  }),
};
