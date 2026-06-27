import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import { env } from "../../config/env.js";
import { S3ClientManager } from "../../config/minio.js";

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

export interface StorageObjectMetadata {
  contentLength?: number;
  contentType?: string;
}

export class StorageService {
  public async createUploadUrl(payload: CreateUploadUrlPayload): Promise<Record<string, unknown>> {
    const client = S3ClientManager.getClient();
    const expiresIn = payload.expiresIn ?? 60 * 5;

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
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
    // When a public base URL is configured, return a permanent public S3 URL
    // instead of generating a short-lived presigned GET URL.
    if (env.AWS_S3_PUBLIC_BASE_URL) {
      const baseUrl = env.AWS_S3_PUBLIC_BASE_URL.replace(/\/$/, "");
      return {
        key,
        expiresIn: 0,
        url: `${baseUrl}/${key}`,
      };
    }

    const client = S3ClientManager.getClient();
    const expiresIn = 60 * 10;

    const command = new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
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
    const client = S3ClientManager.getClient();

    const command = new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
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
    const client = S3ClientManager.getClient();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
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

  public async getObjectMetadata(key: string): Promise<StorageObjectMetadata> {
    const client = S3ClientManager.getClient();
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
      }),
    );

    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  }
}
