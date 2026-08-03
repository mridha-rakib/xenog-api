import { z } from "zod";
import { paymentManagementStatuses } from "./payment-management.interface.js";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const isValidCalendarDate = (value: string): boolean => {
  if (!isoDatePattern.test(value)) return false;
  const parts = value.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 0;
  const day = parts[2] ?? 0;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const MAX_RANGE_DAYS = 365;

export const paymentManagementValidation = {
  list: z
    .object({
      query: z.object({
        page: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        search: z.string().trim().max(120).optional(),
        status: z.enum(paymentManagementStatuses).optional(),
        start: z.string().trim().optional(),
        end: z.string().trim().optional(),
      }),
    })
    .superRefine((value, ctx) => {
      const { start, end } = value.query;

      if (!start && !end) {
        return;
      }

      if (!start || !end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "start and end must both be provided together",
          path: ["query", start ? "end" : "start"],
        });
        return;
      }

      if (!isValidCalendarDate(start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "start must be a valid YYYY-MM-DD date",
          path: ["query", "start"],
        });
        return;
      }

      if (!isValidCalendarDate(end)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "end must be a valid YYYY-MM-DD date",
          path: ["query", "end"],
        });
        return;
      }

      const startDate = new Date(`${start}T00:00:00.000Z`);
      const endDate = new Date(`${end}T00:00:00.000Z`);

      if (startDate.getTime() > endDate.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "start must not be after end",
          path: ["query", "start"],
        });
        return;
      }

      const rangeDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

      if (rangeDays > MAX_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Date range cannot exceed ${MAX_RANGE_DAYS} calendar days`,
          path: ["query", "end"],
        });
      }
    }),
};
