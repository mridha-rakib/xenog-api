import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import { FcmTokenRepository } from "./fcm-token.repository.js";

type FbApp = import("firebase-admin/app").App;
type Messaging = import("firebase-admin/messaging").Messaging;

let messaging: Messaging | null = null;
let initAttempted = false;

const initMessaging = async (): Promise<Messaging | null> => {
  if (initAttempted) return messaging;
  initAttempted = true;

  const hasPath = Boolean(env.FIREBASE_SERVICE_ACCOUNT_PATH);
  const hasJson = Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON);

  if (!hasPath && !hasJson) {
    logger.info("Firebase not configured — push notifications disabled");
    return null;
  }

  try {
    const { initializeApp, getApps, cert } = await import("firebase-admin/app");
    const { getMessaging: getFbMessaging } = await import("firebase-admin/messaging");

    const existingApps = getApps();
    let app: FbApp;

    if (existingApps.length > 0) {
      app = existingApps[0] as FbApp;
    } else {
      let serviceAccount: object;

      if (hasPath) {
        const raw = readFileSync(resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH!), "utf-8");
        serviceAccount = JSON.parse(raw) as object;
      } else {
        serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON!) as object;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app = initializeApp({ credential: cert(serviceAccount as any) });
    }

    messaging = getFbMessaging(app);
    logger.info("Firebase Admin SDK initialized");
    return messaging;
  } catch (error) {
    logger.warn({ error }, "Firebase Admin SDK initialization failed — push notifications disabled");
    return null;
  }
};

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export const sendPushNotifications = async (
  recipientUserIds: string[],
  payload: PushPayload,
  fcmTokenRepository = new FcmTokenRepository(),
): Promise<void> => {
  if (recipientUserIds.length === 0) return;

  const msg = await initMessaging();
  if (!msg) return;

  const tokenDocs = await fcmTokenRepository.findTokensForUsers(recipientUserIds);
  if (tokenDocs.length === 0) return;

  const tokens = tokenDocs.map((d) => d.token);

  try {
    const response = await msg.sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: { priority: "high" },
    });

    const invalidTokens: string[] = [];

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          const t = tokens[idx];
          if (t) invalidTokens.push(t);
        }
      }
    });

    if (invalidTokens.length > 0) {
      await fcmTokenRepository.removeInvalidTokens(invalidTokens).catch(() => undefined);
      logger.debug({ count: invalidTokens.length }, "Removed invalid FCM tokens");
    }

    if (response.failureCount > 0) {
      logger.debug({ failureCount: response.failureCount }, "Some FCM notifications failed");
    }
  } catch (error) {
    logger.warn({ error }, "Failed to send FCM push notifications");
  }
};
