/**
 * Temporary dual-transport bridge for the raw-ws -> Socket.IO migration.
 *
 * During the migration window, chat/notification/presence events must reach
 * BOTH transports: the legacy raw `ws` gateway (old app builds still in the
 * wild) and the new Socket.IO gateway (updated app builds). This module is
 * the single place that knows how to reach both, so business logic
 * (chat-events.service.ts) never has to branch on transport.
 *
 * Deliberately has ZERO imports from either gateway file — both gateways
 * import and register themselves here instead. This keeps the dependency
 * graph acyclic: gateways -> chat-events.service.ts -> this file, never
 * this file -> a gateway.
 */
export type BroadcastTarget = {
  notifyUser(userId: string, legacyEnvelope: unknown, event: string, payload: unknown): void;
};

const targets: BroadcastTarget[] = [];

export const registerBroadcastTarget = (target: BroadcastTarget): void => {
  targets.push(target);
};

export const notifyUserBoth = (
  userId: string,
  legacyEnvelope: unknown,
  event: string,
  payload: unknown,
): void => {
  for (const target of targets) {
    target.notifyUser(userId, legacyEnvelope, event, payload);
  }
};

export const notifyUsersBoth = (
  userIds: string[],
  legacyEnvelope: unknown,
  event: string,
  payload: unknown,
): void => {
  for (const userId of userIds) {
    notifyUserBoth(userId, legacyEnvelope, event, payload);
  }
};
