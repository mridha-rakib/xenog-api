import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import { MinioClient } from "../../config/minio.js";

interface CreateUploadUrlPayload {
  key: string;
  contentType: string;
  expiresIn?: number;
}

export class StorageService {
  public async createUploadUrl(payload: CreateUploadUrlPayload): Promise<Record<string, unknown>> {
    const client = MinioClient.getClient();
    const expiresIn = payload.expiresIn ?? 60 * 5;

    const command = new PutObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key: payload.key,
      ContentType: payload.contentType,
    });

    const url = await getSignedUrl(client, command, { expiresIn });

    return {
      key: payload.key,
      contentType: payload.contentType,
      expiresIn,
      url,
    };
  }

  public async createDownloadUrl(key: string): Promise<Record<string, unknown>> {
    const client = MinioClient.getClient();
    const expiresIn = 60 * 10;

    const command = new GetObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key: key,
    });

    const url = await getSignedUrl(client, command, { expiresIn });

    return {
      key,
      expiresIn,
      url,
    };
  }
}
