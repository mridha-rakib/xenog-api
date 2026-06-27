import { z } from "zod";
import { reportActions, reportStatuses, reportTargetTypes } from "./report.interface.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid MongoDB ObjectId");

export const reportValidation = {
  create: z.object({
    body: z.object({
      reportedUserId: objectId,
      targetType: z.enum(reportTargetTypes),
      targetId: objectId,
      reason: z.string().trim().min(2).max(160),
      details: z.string().trim().max(2000).nullable().optional(),
    }).strict(),
  }),
  list: z.object({
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
      search: z.string().trim().max(120).optional(),
      status: z.enum(reportStatuses).optional(),
      type: z.enum(reportTargetTypes).optional(),
    }),
  }),
  params: z.object({ params: z.object({ id: objectId }) }),
  action: z.object({
    params: z.object({ id: objectId }),
    body: z.object({ action: z.enum(reportActions) }).strict(),
  }),
};
