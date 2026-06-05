import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { logger } from "../core/logger/logger.js";

export class MinioClient {
  private static client: S3Client | null = null;
  private static publicClient: S3Client | null = null;

  private static createClient(endpoint: string, port: number, useSsl: boolean): S3Client {
    return new S3Client({
      region: env.AWS_REGION,
      endpoint: `${useSsl ? "https" : "http"}://${endpoint}:${port}`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
    });
  }

  public static getClient(): S3Client {
    if (this.client) {
      return this.client;
    }

    this.client = this.createClient(env.MINIO_ENDPOINT, env.MINIO_PORT, env.MINIO_USE_SSL);

    return this.client;
  }

  public static getPresignClient(): S3Client {
    if (!env.MINIO_PUBLIC_ENDPOINT) {
      return this.getClient();
    }

    if (this.publicClient) {
      return this.publicClient;
    }

    this.publicClient = this.createClient(
      env.MINIO_PUBLIC_ENDPOINT,
      env.MINIO_PUBLIC_PORT ?? env.MINIO_PORT,
      env.MINIO_PUBLIC_USE_SSL ?? env.MINIO_USE_SSL,
    );

    return this.publicClient;
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
