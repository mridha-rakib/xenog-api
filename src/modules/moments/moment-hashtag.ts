const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;
const MAX_HASHTAGS = 20;
const MAX_HASHTAG_LENGTH = 64;

export const normalizeHashtag = (value: string): string => {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^#+/, "")
    .toLocaleLowerCase();

  return (normalized.match(/^[\p{L}\p{N}_]+/u)?.[0] ?? "").slice(0, MAX_HASHTAG_LENGTH);
};

export const extractHashtags = (caption?: string | null): string[] => {
  if (!caption) return [];

  const tags = new Set<string>();

  for (const match of caption.matchAll(HASHTAG_PATTERN)) {
    const hashtag = normalizeHashtag(match[0]);
    if (hashtag) tags.add(hashtag);
    if (tags.size >= MAX_HASHTAGS) break;
  }

  return [...tags];
};
