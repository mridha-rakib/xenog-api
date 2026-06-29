import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../core/errors/app-error.js";
import { ApiResponse } from "../../core/http/api-response.js";
import { logger } from "../../core/logger/logger.js";
import { StorageService } from "./storage.service.js";

interface StorageErrorLike {
  $metadata?: {
    httpStatusCode?: number;
  };
  Code?: string;
  code?: string;
  name?: string;
}

const STORAGE_NOT_FOUND_CODES = new Set(["NoSuchKey", "NotFound", "NotFoundException"]);
const STORAGE_INVALID_RANGE_CODES = new Set(["InvalidRange", "RequestedRangeNotSatisfiable"]);
const STORAGE_RETRYABLE_CODES = new Set([
  "RequestTimeout",
  "ServiceUnavailable",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TimeoutError",
]);

const getStorageErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const storageError = error as StorageErrorLike;
  return storageError.Code ?? storageError.code ?? storageError.name;
};

const getStorageErrorHttpStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const statusCode = (error as StorageErrorLike).$metadata?.httpStatusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
};

const getSupportedRangeHeader = (rangeHeader: Request["headers"]["range"]): string | undefined => {
  if (typeof rangeHeader !== "string") {
    return undefined;
  }

  if (!/^bytes=(\d+-\d*|\d*-\d+)$/.test(rangeHeader)) {
    throw new AppError("Invalid Range header", 416);
  }

  return rangeHeader;
};

const escapeHeaderFilename = (filename: string): string => filename.replace(/["\\]/g, "_");

const isClientAbortError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = getStorageErrorCode(error);
  return code === "AbortError" || code === "ERR_STREAM_PREMATURE_CLOSE";
};

const toStorageAppError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  const code = getStorageErrorCode(error);
  const statusCode = getStorageErrorHttpStatus(error);

  if (statusCode === 404 || (code && STORAGE_NOT_FOUND_CODES.has(code))) {
    return new AppError("Storage object not found", 404);
  }

  if (statusCode === 416 || (code && STORAGE_INVALID_RANGE_CODES.has(code))) {
    return new AppError("Requested range not satisfiable", 416);
  }

  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    (code && STORAGE_RETRYABLE_CODES.has(code))
  ) {
    return new AppError("Storage service unavailable", 503);
  }

  return new AppError("Storage service failed", 502);
};

export class StorageController {
  public constructor(private readonly storageService = new StorageService()) {}

  public createUploadUrl = async (req: Request, res: Response): Promise<void> => {
    const uploadUrl = await this.storageService.createUploadUrl(req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Upload URL created",
      data: uploadUrl,
    });
  };

  public createDownloadUrl = async (req: Request, res: Response): Promise<void> => {
    const { key } = req.params as { key: string };
    const downloadUrl = await this.storageService.createDownloadUrl(key);

    ApiResponse.success(res, {
      message: "Download URL created",
      data: downloadUrl,
    });
  };

  public uploadFile = async (req: Request, res: Response): Promise<void> => {
    const { key, contentType } = req.query as { key: string; contentType?: string };
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

    const upload = await this.storageService.uploadObject({
      key,
      contentType: contentType || req.headers["content-type"] || "application/octet-stream",
      body,
    });

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "File uploaded",
      data: upload,
    });
  };

  public streamFile = async (req: Request, res: Response): Promise<void> => {
    const { key, contentType } = req.query as { key: string; contentType?: string };
    const { filename: routeFilename } = req.params as { filename?: string };
    const filename = routeFilename ?? key.split("/").pop();
    const range = getSupportedRangeHeader(req.headers.range);
    const abortController = new AbortController();
    let body: Readable | undefined;
    let streamFinished = false;

    const cleanupBody = (reason?: Error): void => {
      if (body && !body.destroyed) {
        body.destroy(reason);
      }
    };

    const abortStreaming = (): void => {
      if (streamFinished || abortController.signal.aborted) {
        return;
      }

      abortController.abort();
      cleanupBody(new Error("Client disconnected during storage stream"));
    };

    const abortOnEarlyClose = (): void => {
      if (!res.writableEnded) {
        abortStreaming();
      }
    };

    req.on("aborted", abortStreaming);
    res.on("close", abortOnEarlyClose);
    res.on("error", abortStreaming);

    try {
      const file = await this.storageService.getObject(key, range, abortController.signal);
      body = file.body;

      if (abortController.signal.aborted || req.aborted || res.destroyed) {
        cleanupBody(new Error("Client disconnected before storage stream started"));
        return;
      }

      res.setHeader("Accept-Ranges", "bytes");

      const responseContentType = contentType || file.contentType;

      if (responseContentType) {
        res.setHeader("Content-Type", responseContentType);
      }

      if (file.contentRange) {
        res.status(httpStatus.PARTIAL_CONTENT);
        res.setHeader("Content-Range", file.contentRange);
      }

      if (file.contentLength !== undefined) {
        res.setHeader("Content-Length", file.contentLength);
      }

      if (filename) {
        res.setHeader("Content-Disposition", `inline; filename="${escapeHeaderFilename(filename)}"`);
      }

      res.setHeader("Cache-Control", "private, max-age=300");

      await pipeline(body, res);
      streamFinished = true;
    } catch (error) {
      cleanupBody(error instanceof Error ? error : undefined);

      if (abortController.signal.aborted || req.aborted || isClientAbortError(error)) {
        return;
      }

      if (!res.headersSent) {
        throw toStorageAppError(error);
      }

      logger.error({ error, key, range }, "Storage stream failed after response started");
    } finally {
      streamFinished = true;
      cleanupBody();
      req.off("aborted", abortStreaming);
      res.off("close", abortOnEarlyClose);
      res.off("error", abortStreaming);
    }
  };
}
