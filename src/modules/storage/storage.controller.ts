import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import { StorageService } from "./storage.service.js";

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
}
