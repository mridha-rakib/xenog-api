import { dashboardValidation } from "../dashboard/dashboard.validation.js";

/**
 * The Analytics `range`/`start`/`end` query contract is identical to the
 * Dashboard Overview's — same presets, same custom-date rules (valid
 * calendar dates, start <= end, max 365-day span). Reusing the existing,
 * already-tested schema read-only avoids re-implementing (and risking
 * drifting from) the same validation rules a second time.
 */
export const analyticsValidation = {
  overview: dashboardValidation.overview,
};
