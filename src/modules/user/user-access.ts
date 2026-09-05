import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { IUser } from "./user.interface.js";
import type { UserBlockRepository } from "./user-block.repository.js";

// ── Shared account-access rules (privacy / permission enforcement) ─────────
// Additive helpers only. These centralise two checks that were previously
// duplicated (or missing) across profile, moment and story surfaces:
//
//   1. isUserPubliclyViewable(user) — is this account allowed to be seen by
//      anyone other than itself? (suspended / inactive / deleted / non-user
//      accounts are not).
//   2. block-relationship checks — has either side blocked the other?
//
// Nothing here changes the existing block storage model, auth, payments,
// tickets, events or chat. It only reads UserBlockRepository, which already
// exists.

type BlockRelationshipRepository = Pick<UserBlockRepository, "isBlocked">;

/**
 * An account is publicly viewable (by users other than itself) only when it
 * is an active, non-deleted regular user. Suspended / banned accounts have
 * `isActive === false`; anonymised / deleted accounts carry `deletedAt`.
 */
export const isUserPubliclyViewable = (user: IUser | null | undefined): boolean =>
  Boolean(user && user.isActive === true && user.role === "user" && !user.deletedAt);

export interface BlockRelationship {
  viewerHasBlockedTarget: boolean;
  targetHasBlockedViewer: boolean;
}

/**
 * Directional block state between two users. Returns all-false for the
 * self case so callers never have to special-case "viewing my own profile".
 */
export const getBlockRelationship = async (
  blockRepository: BlockRelationshipRepository,
  viewerId: string,
  targetUserId: string,
): Promise<BlockRelationship> => {
  if (!viewerId || !targetUserId || viewerId === targetUserId) {
    return { viewerHasBlockedTarget: false, targetHasBlockedViewer: false };
  }

  const [viewerHasBlockedTarget, targetHasBlockedViewer] = await Promise.all([
    blockRepository.isBlocked(viewerId, targetUserId),
    blockRepository.isBlocked(targetUserId, viewerId),
  ]);

  return { viewerHasBlockedTarget, targetHasBlockedViewer };
};

/** True when either side has blocked the other. */
export const isBlockedBetween = async (
  blockRepository: BlockRelationshipRepository,
  viewerId: string,
  targetUserId: string,
): Promise<boolean> => {
  const { viewerHasBlockedTarget, targetHasBlockedViewer } = await getBlockRelationship(
    blockRepository,
    viewerId,
    targetUserId,
  );

  return viewerHasBlockedTarget || targetHasBlockedViewer;
};

/**
 * Throw when a block exists in either direction. Default message/status match
 * the pre-existing profile-visibility errors so no client behaviour changes.
 */
export const assertNotBlockedBetween = async (
  blockRepository: BlockRelationshipRepository,
  viewerId: string,
  targetUserId: string,
  message = "Profile unavailable",
  statusCode: number = httpStatus.FORBIDDEN,
): Promise<void> => {
  if (await isBlockedBetween(blockRepository, viewerId, targetUserId)) {
    throw new AppError(message, statusCode);
  }
};
