import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { logger } from "../core/logger/logger.js";

export class MinioClient {
  private static client: S3Client | null = null;

  public static getClient(): S3Client {
    if (this.client) {
      return this.client;
    }

    this.client = new S3Client({
      region: "us-east-1",
      endpoint: `${env.MINIO_USE_SSL ? "https" : "http"}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
    });

    return this.client;
  }

  public static async ensureBucket(): Promise<void> {
    const client = this.getClient();

    try {
      await client.send(new HeadBucketCommand({ Bucket: env.MINIO_BUCKET }));
      logger.info({ bucket: env.MINIO_BUCKET }, "MinIO bucket ready");
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: env.MINIO_BUCKET }));
      logger.info({ bucket: env.MINIO_BUCKET }, "MinIO bucket created");
    }
  }
}
