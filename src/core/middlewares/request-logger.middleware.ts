import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "../logger/logger.js";
import { RequestContext } from "../logger/request-context.js";

export const requestLogger: RequestHandler = (req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? crypto.randomUUID();
  const startedAt = process.hrtime.bigint();

  res.setHeader("x-request-id", requestId);

  RequestContext.run({ requestId }, () => {
    logger.info(
      {
        request: {
          method: req.method,
          url: req.originalUrl,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
      },
      "Request received",
    );

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logger.info(
        {
          request: {
            method: req.method,
            url: req.originalUrl,
          },
          response: {
            statusCode: res.statusCode,
            durationMs: Number(durationMs.toFixed(2)),
          },
        },
        "Response sent",
      );
    });

    next();
  });
};
