/**
 * Legacy Event timezone backfill (Batch 3A.1) — METADATA ONLY.
 *
 * Fills `Event.timezone` for legacy Events that have no timezone yet but DO have
 * valid venue coordinates, by running those coordinates through the one
 * authoritative server resolver (`resolveEventTimeZoneFromCoordinates`).
 *
 *   location.latitude/longitude  ->  resolveEventTimeZoneFromCoordinates(...)  ->  "America/New_York"
 *   $set: { timezone: "America/New_York" }
 *
 * It NEVER touches `scheduledAt` / `endAt` / `publishedAt` / any other field.
 * Legacy remote-created Events keep their stored absolute instant byte-for-byte
 * — the original creator wall-clock intent is unrecoverable from current data
 * and is deliberately NOT reconstructed here (see the report caveat).
 *
 * Safety:
 *   - DRY RUN by default. Writes require an explicit `--apply`.
 *   - Idempotent: a filled `timezone` is never a candidate on the next run.
 *   - Race-safe: the write filter still requires `timezone` null/missing, so a
 *     value that appeared after the scan is never overwritten.
 *   - Cursor-scanned in `_id` ascending order; bounded memory.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-event-timezones.ts                # DRY RUN
 *   npx tsx src/scripts/backfill-event-timezones.ts --apply        # write
 *   npx tsx src/scripts/backfill-event-timezones.ts --limit=100    # bounded scan
 *   npx tsx src/scripts/backfill-event-timezones.ts --apply --batch-size=500
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { EventModel } from "../modules/events/event.model.js";
import { resolveEventTimeZoneFromCoordinates } from "../modules/events/event-timezone.js";

export const BACKFILL_DEFAULT_BATCH_SIZE = 200;
export const BACKFILL_DEFAULT_SAMPLE_LIMIT = 10;

// ── options ───────────────────────────────────────────────────────────────

export type BackfillOptions = {
  /** Default false. Only `--apply` performs writes. */
  apply: boolean;
  /** Optional bounded scan size (> 0). `null` = full backfill. */
  limit: number | null;
  /** DB cursor batch size (> 0). */
  batchSize: number;
  /** How many "would update" / "update" rows to print as samples (>= 0). */
  sampleLimit: number;
};

export type ParseBackfillOptionsResult =
  | { ok: true; options: BackfillOptions }
  | { ok: false; error: string };

const parsePositiveInt = (raw: string, allowZero: boolean): number | null => {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return null;
  }
  if (value < 0 || (!allowZero && value === 0)) {
    return null;
  }
  return value;
};

export const parseBackfillOptions = (argv: readonly string[]): ParseBackfillOptionsResult => {
  const options: BackfillOptions = {
    apply: false,
    limit: null,
    batchSize: BACKFILL_DEFAULT_BATCH_SIZE,
    sampleLimit: BACKFILL_DEFAULT_SAMPLE_LIMIT,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }

    const limitMatch = /^--limit=(.*)$/.exec(arg);
    if (limitMatch) {
      const value = parsePositiveInt(limitMatch[1] ?? "", false);
      if (value === null) {
        return { ok: false, error: `--limit must be a positive integer (got "${limitMatch[1]}")` };
      }
      options.limit = value;
      continue;
    }

    const batchMatch = /^--batch-size=(.*)$/.exec(arg);
    if (batchMatch) {
      const value = parsePositiveInt(batchMatch[1] ?? "", false);
      if (value === null) {
        return { ok: false, error: `--batch-size must be a positive integer (got "${batchMatch[1]}")` };
      }
      options.batchSize = value;
      continue;
    }

    const sampleMatch = /^--sample=(.*)$/.exec(arg);
    if (sampleMatch) {
      const value = parsePositiveInt(sampleMatch[1] ?? "", true);
      if (value === null) {
        return { ok: false, error: `--sample must be a non-negative integer (got "${sampleMatch[1]}")` };
      }
      options.sampleLimit = value;
      continue;
    }

    return { ok: false, error: `Unknown option "${arg}"` };
  }

  return { ok: true, options };
};

// ── classification (pure) ─────────────────────────────────────────────────

export type LegacyEventTimezoneCandidate = {
  id: string;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type BackfillClassification =
  | { action: "skip_existing_timezone" }
  | { action: "skip_invalid_coordinates" }
  | { action: "skip_unresolved" }
  | { action: "resolve"; timezone: string; latitude: number; longitude: number };

export type CoordinateResolver = (latitude: unknown, longitude: unknown) => string | null;

const hasUsableCoordinate = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * Decide what the backfill should do with one legacy Event. Pure — the
 * coordinate→IANA resolver is injected (defaults to the authoritative one).
 */
export const classifyLegacyEventTimezoneCandidate = (
  candidate: LegacyEventTimezoneCandidate,
  resolve: CoordinateResolver = resolveEventTimeZoneFromCoordinates,
): BackfillClassification => {
  // (8) An existing timezone always wins — never a reconciliation tool.
  if (typeof candidate.timezone === "string" && candidate.timezone.trim().length > 0) {
    return { action: "skip_existing_timezone" };
  }

  const { latitude, longitude } = candidate;
  if (!hasUsableCoordinate(latitude, -90, 90) || !hasUsableCoordinate(longitude, -180, 180)) {
    return { action: "skip_invalid_coordinates" };
  }

  let zone: string | null;
  try {
    zone = resolve(latitude, longitude);
  } catch {
    zone = null;
  }
  if (!zone) {
    return { action: "skip_unresolved" };
  }

  return { action: "resolve", timezone: zone, latitude, longitude };
};

// ── race-safe write shape (pure) ─────────────────────────────────────────

/**
 * The ONLY write this backfill performs. The filter still requires `timezone`
 * null/missing so a concurrently-populated value is never overwritten; the
 * update is exclusively `$set: { timezone }` — no schedule / location / status.
 */
export const buildTimezoneBackfillWrite = (
  id: string,
  timezone: string,
): {
  filter: { _id: string; $or: Array<Record<string, unknown>> };
  update: { $set: { timezone: string } };
} => ({
  filter: {
    _id: id,
    $or: [{ timezone: null }, { timezone: { $exists: false } }],
  },
  update: { $set: { timezone } },
});

// ── runner (pure over injected IO) ──────────────────────────────────────

export type BackfillCounters = {
  scanned: number;
  skippedExisting: number;
  invalidCoordinates: number;
  unresolved: number;
  resolved: number;
  wouldUpdate: number;
  updated: number;
  concurrentSkipped: number;
  failed: number;
};

export type BackfillSample = {
  id: string;
  latitude: number;
  longitude: number;
  timezone: string;
  action: "WOULD UPDATE" | "UPDATE";
};

export type BackfillResult = {
  apply: boolean;
  counters: BackfillCounters;
  samples: BackfillSample[];
};

export type ScanCandidates = (input: {
  batchSize: number;
  limit: number | null;
}) => AsyncIterable<LegacyEventTimezoneCandidate>;

/** Applies exactly `buildTimezoneBackfillWrite`; returns Mongo's matched count. */
export type ApplyTimezone = (id: string, timezone: string) => Promise<{ matchedCount: number }>;

const zeroCounters = (): BackfillCounters => ({
  scanned: 0,
  skippedExisting: 0,
  invalidCoordinates: 0,
  unresolved: 0,
  resolved: 0,
  wouldUpdate: 0,
  updated: 0,
  concurrentSkipped: 0,
  failed: 0,
});

export const runEventTimezoneBackfill = async (
  deps: {
    scan: ScanCandidates;
    apply: ApplyTimezone;
    resolve?: CoordinateResolver;
  },
  options: BackfillOptions,
): Promise<BackfillResult> => {
  const counters = zeroCounters();
  const samples: BackfillSample[] = [];

  for await (const candidate of deps.scan({ batchSize: options.batchSize, limit: options.limit })) {
    counters.scanned += 1;
    const classification = classifyLegacyEventTimezoneCandidate(candidate, deps.resolve);

    switch (classification.action) {
      case "skip_existing_timezone":
        counters.skippedExisting += 1;
        break;
      case "skip_invalid_coordinates":
        counters.invalidCoordinates += 1;
        break;
      case "skip_unresolved":
        counters.unresolved += 1;
        break;
      case "resolve": {
        counters.resolved += 1;
        if (samples.length < options.sampleLimit) {
          samples.push({
            id: candidate.id,
            latitude: classification.latitude,
            longitude: classification.longitude,
            timezone: classification.timezone,
            action: options.apply ? "UPDATE" : "WOULD UPDATE",
          });
        }

        if (!options.apply) {
          counters.wouldUpdate += 1;
          break;
        }

        try {
          const { matchedCount } = await deps.apply(candidate.id, classification.timezone);
          if (matchedCount === 0) {
            counters.concurrentSkipped += 1;
          } else {
            counters.updated += 1;
          }
        } catch {
          counters.failed += 1;
        }
        break;
      }
    }
  }

  return { apply: options.apply, counters, samples };
};

// ── report ──────────────────────────────────────────────────────────────

export const formatBackfillReport = (result: BackfillResult): string => {
  const { apply, counters, samples } = result;
  const lines: string[] = [];
  lines.push(apply ? "Event timezone backfill — APPLY" : "Event timezone backfill — DRY RUN (no writes)");
  lines.push(`  scanned:             ${counters.scanned}`);
  lines.push(`  skippedExisting:     ${counters.skippedExisting}`);
  lines.push(`  invalidCoordinates:  ${counters.invalidCoordinates}`);
  lines.push(`  unresolved:          ${counters.unresolved}`);
  lines.push(`  resolved:            ${counters.resolved}`);
  if (apply) {
    lines.push(`  updated:             ${counters.updated}`);
    lines.push(`  concurrentSkipped:   ${counters.concurrentSkipped}`);
    lines.push(`  failed:              ${counters.failed}`);
  } else {
    lines.push(`  wouldUpdate:         ${counters.wouldUpdate}`);
  }
  if (samples.length > 0) {
    lines.push("  samples:");
    for (const sample of samples) {
      lines.push(
        `    Event ${sample.id}  coords: ${sample.latitude.toFixed(4)},${sample.longitude.toFixed(4)}  timezone: ${sample.timezone}  action: ${sample.action}`,
      );
    }
  }
  return lines.join("\n");
};

// ── Mongo IO (only used when run as a script) ───────────────────────────

const scanCandidatesFromMongo: ScanCandidates = async function* ({ batchSize, limit }) {
  const base = EventModel.find({
    $or: [{ timezone: null }, { timezone: { $exists: false } }],
  })
    .select({ _id: 1, timezone: 1, "location.latitude": 1, "location.longitude": 1 })
    .sort({ _id: 1 })
    .lean()
    .batchSize(batchSize);

  const cursor = (limit != null ? base.limit(limit) : base).cursor();

  for await (const doc of cursor) {
    yield {
      id: String(doc._id),
      timezone: doc.timezone ?? null,
      latitude: doc.location?.latitude ?? null,
      longitude: doc.location?.longitude ?? null,
    };
  }
};

const applyTimezoneToMongo: ApplyTimezone = async (id, timezone) => {
  const { filter, update } = buildTimezoneBackfillWrite(id, timezone);
  const res = await EventModel.updateOne(filter as Record<string, unknown>, update);
  return { matchedCount: res.matchedCount ?? 0 };
};

const main = async (): Promise<number> => {
  const parsed = parseBackfillOptions(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }

  await mongoose.connect(env.MONGODB_URI);
  try {
    const result = await runEventTimezoneBackfill(
      { scan: scanCandidatesFromMongo, apply: applyTimezoneToMongo },
      parsed.options,
    );
    console.log(formatBackfillReport(result));
    return 0;
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
};

// This project builds `.ts` scripts as CommonJS (no `"type": "module"`), so
// `import.meta` is unavailable — detect a direct `tsx` invocation from argv.
const entryPath = (process.argv[1] ?? "").replace(/\\/g, "/");
const invokedDirectly = /\/scripts\/backfill-event-timezones\.(ts|js)$/.test(entryPath);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error("Event timezone backfill failed", error);
      await mongoose.disconnect().catch(() => undefined);
      process.exitCode = 1;
    });
}
