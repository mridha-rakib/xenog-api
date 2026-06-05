import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import { env } from "../../config/env.js";
import { MinioClient } from "../../config/minio.js";

interface CreateUploadUrlPayload {
  key: string;
  contentType: string;
  expiresIn?: number;
}

export interface StorageDownloadUrl {
  key: string;
  expiresIn: number;
  url: string;
}

export interface StorageObject {
  body: Readable;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
}

export class StorageService {
  public async createUploadUrl(payload: CreateUploadUrlPayload): Promise<Record<string, unknown>> {
    const client = MinioClient.getPresignClient();
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

  public async createDownloadUrl(key: string): Promise<StorageDownloadUrl> {
    const client = MinioClient.getPresignClient();
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

  public async uploadObject(payload: { body: Buffer; contentType: string; key: string }): Promise<{ key: string }> {
    const client = MinioClient.getClient();

    const command = new PutObjectCommand({
      Bucket: env.MINIO_BUCKET,
      Key: payload.key,
      Body: payload.body,
      ContentLength: payload.body.length,
      ContentType: payload.contentType,
    });

    await client.send(command);

    return {
      key: payload.key,
    };
  }

  public async getObject(key: string, range?: string): Promise<StorageObject> {
    const client = MinioClient.getClient();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
        Range: range,
      }),
    );

    return {
      body: response.Body as Readable,
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
    };
  }
}
