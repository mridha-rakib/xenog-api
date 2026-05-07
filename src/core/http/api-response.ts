import type { Response } from "express";
import httpStatus from "http-status";
import { RequestContext } from "../logger/request-context.js";

interface SuccessOptions<T> {
  statusCode?: number;
  message?: string;
  data?: T;
  meta?: Record<string, unknown>;
}

interface ErrorOptions {
  statusCode?: number;
  message: string;
  details?: unknown;
  stack?: string;
}

export class ApiResponse {
  public static success<T>(
    res: Response,
    { statusCode = httpStatus.OK, message = "Success", data, meta }: SuccessOptions<T>,
  ): Response {
    return res.status(statusCode).json({
      success: true,
      statusCode,
      message,
      data,
      meta,
      requestId: RequestContext.getRequestId(),
    });
  }

  public static error(
    res: Response,
    { statusCode = httpStatus.INTERNAL_SERVER_ERROR, message, details, stack }: ErrorOptions,
  ): Response {
    return res.status(statusCode).json({
      success: false,
      statusCode,
      message,
      details,
      stack,
      requestId: RequestContext.getRequestId(),
    });
  }
}
