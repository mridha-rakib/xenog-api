import compression from "compression";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./core/errors/error-handler.js";
import { requestLogger } from "./core/middlewares/request-logger.middleware.js";
import { notFoundHandler } from "./core/middlewares/not-found.middleware.js";
import { appRoutes } from "./routes/index.js";

export const createApp = () => {
  const app = express();
  const corsOrigin = env.CORS_ORIGIN ?? env.APP_ORIGIN;
  const bodyLimit = `${env.REQUEST_BODY_LIMIT_MB}mb`;

  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((origin) => origin.trim()),
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(
    express.json({
      limit: bodyLimit,
      verify: (req, _res, buf) => {
        const request = req as express.Request;

        if (request.originalUrl === `${env.API_PREFIX}/payments/stripe/webhook`) {
          request.rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));
  app.use(requestLogger);
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  const statusResponse = {
    success: true,
    message: `${env.APP_NAME} is running`,
    docs: `${env.PUBLIC_API_PREFIX ?? env.API_PREFIX}/health`,
  };

  app.get(env.API_PREFIX, (_req, res) => {
    res.json(statusResponse);
  });

  app.use(env.API_PREFIX, appRoutes);

  app.get("/", (_req, res) => {
    res.json({
      ...statusResponse,
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
