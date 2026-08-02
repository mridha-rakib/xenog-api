import { z } from "zod";
import { dashboardRangePresets } from "./dashboard.interface.js";

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

const MAX_CUSTOM_RANGE_DAYS = 365;

export const dashboardValidation = {
  overview: z
    .object({
      query: z.object({
        range: z.enum(dashboardRangePresets).optional(),
        start: z.string().trim().optional(),
        end: z.string().trim().optional(),
      }),
    })
    .superRefine((value, ctx) => {
      const { range, start, end } = value.query;

      if (range !== "custom") {
        return;
      }

      if (!start || !isValidCalendarDate(start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "start must be a valid YYYY-MM-DD date when range is custom",
          path: ["query", "start"],
        });
        return;
      }

      if (!end || !isValidCalendarDate(end)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "end must be a valid YYYY-MM-DD date when range is custom",
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

      if (rangeDays > MAX_CUSTOM_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Custom range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} calendar days`,
          path: ["query", "end"],
        });
      }
    }),
};
