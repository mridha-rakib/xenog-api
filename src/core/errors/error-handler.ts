import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { Error as MongooseError } from "mongoose";
import httpStatus from "http-status";
import { AppError } from "./app-error.js";
import { logger } from "../logger/logger.js";
import { ApiResponse } from "../http/api-response.js";
import { env } from "../../config/env.js";
import { formatZodError } from "../validation/zod-error.formatter.js";

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
}

const getHttpLikeStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const { status, statusCode } = error as HttpLikeError;
  const candidate = statusCode ?? status;

  return typeof candidate === "number" && candidate >= 400 && candidate < 600 ? candidate : undefined;
};

const isJsonParseError = (error: unknown): boolean =>
  error instanceof SyntaxError &&
  typeof error === "object" &&
  error !== null &&
  (error as HttpLikeError).type === "entity.parse.failed";

const getStatusCode = (error: unknown): number => {
  if (error instanceof AppError) {
    return error.statusCode;
  }

  const httpLikeStatusCode = getHttpLikeStatusCode(error);
  if (httpLikeStatusCode) {
    return httpLikeStatusCode;
  }

  if (error instanceof ZodError) {
    return httpStatus.BAD_REQUEST;
  }

  if (error instanceof MongooseError.ValidationError) {
    return httpStatus.BAD_REQUEST;
  }

  if (error instanceof MongooseError.CastError) {
    return httpStatus.BAD_REQUEST;
  }

  return httpStatus.INTERNAL_SERVER_ERROR;
};

const getErrorDetails = (error: unknown): unknown => {
  if (error instanceof AppError) {
    return error.details;
  }

  if (isJsonParseError(error)) {
    return {
      type: "entity.parse.failed",
    };
  }

  if (error instanceof ZodError) {
    return formatZodError(error);
  }

  if (error instanceof MongooseError.ValidationError) {
    return Object.values(error.errors).map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
  }

  return undefined;
};

const getMessage = (error: unknown): string => {
  if (isJsonParseError(error)) {
    return "Invalid JSON payload";
  }

  if (error instanceof ZodError) {
    return "Validation failed";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong";
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const statusCode = getStatusCode(error);
  const details = getErrorDetails(error);
  const message =
    statusCode === httpStatus.INTERNAL_SERVER_ERROR && env.NODE_ENV === "production"
      ? "Internal server error"
      : getMessage(error);

  logger.error(
    {
      error,
      request: {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
      response: {
        statusCode,
      },
      details,
    },
    "Request failed",
  );

  ApiResponse.error(res, {
    statusCode,
    message,
    details,
    stack: env.NODE_ENV === "production" ? undefined : error instanceof Error ? error.stack : undefined,
  });
};
