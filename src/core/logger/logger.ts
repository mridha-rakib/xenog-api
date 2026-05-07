import pino from "pino";
import { env } from "../../config/env.js";
import { RequestContext } from "./request-context.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    app: env.APP_NAME,
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  mixin() {
    const requestId = RequestContext.getRequestId();
    return requestId ? { requestId } : {};
  },
});
