const DEFAULT_MAX_LENGTH = 300;

// Matches http(s) URLs (covers signed S3/CloudFront URLs), long base64/token-like
// runs, Stripe-style secret keys, and AWS access key IDs.
const SENSITIVE_VALUE_PATTERN = /(https?:\/\/\S+)|([A-Za-z0-9+/_-]{40,}={0,2})|(sk_[a-zA-Z0-9]+)|(AKIA[0-9A-Z]{16})/g;

// Matches obvious absolute filesystem paths (POSIX temp/home dirs, Windows drive paths).
const PATH_LIKE_PATTERN = /(\/(?:tmp|var|home|private)\/\S+)|([A-Za-z]:\\\S+)/g;

/**
 * Reduces an arbitrary error (Error instance, string, or unknown thrown value)
 * to a short, single-line, bounded-length summary safe to persist internally
 * and never contains signed URLs, credentials, tokens, or raw filesystem paths.
 * This does not make the summary safe for a public/mobile API response by
 * itself — it only bounds and redacts; callers still decide what, if anything,
 * of the internal summary is ever exposed externally (in this phase, nothing is).
 */
export const sanitizeErrorSummary = (input: unknown, maxLength = DEFAULT_MAX_LENGTH): string => {
  const raw = input instanceof Error
    ? input.message
    : typeof input === "string"
      ? input
      : String(input ?? "unknown error");

  const collapsedWhitespace = raw.replace(/\s+/g, " ").trim();
  const withoutSensitiveValues = collapsedWhitespace.replace(SENSITIVE_VALUE_PATTERN, "[redacted]");
  const withoutPaths = withoutSensitiveValues.replace(PATH_LIKE_PATTERN, "[path]");
  const bounded = withoutPaths.length > maxLength
    ? `${withoutPaths.slice(0, Math.max(0, maxLength - 1))}…`
    : withoutPaths;

  return bounded.length > 0 ? bounded : "unknown error";
};
