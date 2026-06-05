import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import { StorageService } from "./storage.service.js";

const getSupportedRangeHeader = (rangeHeader: Request["headers"]["range"]): string | undefined => {
  if (typeof rangeHeader !== "string") {
    return undefined;
  }

  return /^bytes=(\d+-\d*|\d*-\d+)$/.test(rangeHeader) ? rangeHeader : undefined;
};

const escapeHeaderFilename = (filename: string): string => filename.replace(/["\\]/g, "_");

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
    const file = await this.storageService.getObject(key, range);

    res.setHeader("Accept-Ranges", "bytes");

    const responseContentType = contentType || file.contentType;

    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    if (file.contentRange) {
      res.status(httpStatus.PARTIAL_CONTENT);
      res.setHeader("Content-Range", file.contentRange);
    }

    if (file.contentLength) {
      res.setHeader("Content-Length", file.contentLength);
    }

    if (filename) {
      res.setHeader("Content-Disposition", `inline; filename="${escapeHeaderFilename(filename)}"`);
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    file.body.pipe(res);
  };
}
