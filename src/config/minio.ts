import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { logger } from "../core/logger/logger.js";

export class S3ClientManager {
  private static client: S3Client | null = null;

  public static getClient(): S3Client {
    if (this.client) {
      return this.client;
    }

    this.client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    return this.client;
  }

  public static async ensureBucket(): Promise<void> {
    const client = this.getClient();

    try {
      await client.send(new HeadBucketCommand({ Bucket: env.AWS_S3_BUCKET }));
      logger.info({ bucket: env.AWS_S3_BUCKET }, "S3 bucket ready");
    } catch (error) {
      logger.error(
        { bucket: env.AWS_S3_BUCKET, error },
        "S3 bucket not accessible — verify AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY",
      );
      throw error;
    }
  }
}
