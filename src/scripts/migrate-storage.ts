/**
 * Storage migration script — copies all objects from one S3 bucket to another.
 *
 * Required env vars:
 *   SOURCE_S3_ENDPOINT   — e.g. https://play.min.io  (omit for native AWS S3)
 *   SOURCE_S3_BUCKET     — source bucket name (falls back to AWS_S3_BUCKET)
 *   SOURCE_S3_ACCESS_KEY — source AWS_ACCESS_KEY_ID  (falls back to AWS_ACCESS_KEY_ID)
 *   SOURCE_S3_SECRET_KEY — source AWS_SECRET_ACCESS_KEY (falls back to AWS_SECRET_ACCESS_KEY)
 *
 *   TARGET_S3_ENDPOINT   — omit for native AWS S3
 *   TARGET_S3_BUCKET     — defaults to source bucket name
 *   TARGET_S3_ACCESS_KEY — required
 *   TARGET_S3_SECRET_KEY — required
 *
 * Optional:
 *   MIGRATE_STORAGE_PREFIX    — only copy keys with this prefix
 *   MIGRATE_STORAGE_OVERWRITE — set to "true" to overwrite existing objects
 *   AWS_REGION                — default "us-east-1"
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import type { Readable } from "node:stream";

dotenv.config();

interface StorageConfig {
  bucket: string;
  client: S3Client;
}

const required = (name: string, fallbackName?: string): string => {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const asBoolean = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
};

const createClient = (
  accessKeyId: string,
  secretAccessKey: string,
  endpoint?: string,
): S3Client => {
  const config: S3ClientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
  };

  if (endpoint) {
    config.endpoint = endpoint;
    config.forcePathStyle = true;
  }

  return new S3Client(config);
};

const source: StorageConfig = {
  bucket: required("SOURCE_S3_BUCKET", "AWS_S3_BUCKET"),
  client: createClient(
    required("SOURCE_S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"),
    required("SOURCE_S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"),
    process.env.SOURCE_S3_ENDPOINT,
  ),
};

const target: StorageConfig = {
  bucket: process.env.TARGET_S3_BUCKET || source.bucket,
  client: createClient(
    required("TARGET_S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"),
    required("TARGET_S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"),
    process.env.TARGET_S3_ENDPOINT,
  ),
};

const prefix = process.env.MIGRATE_STORAGE_PREFIX || undefined;
const overwrite = asBoolean(process.env.MIGRATE_STORAGE_OVERWRITE);

const targetHasObject = async (key: string): Promise<boolean> => {
  try {
    await target.client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
    return true;
  } catch (error) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;

    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }

    throw error;
  }
};

const copyObject = async (key: string): Promise<"copied" | "skipped"> => {
  if (!overwrite && (await targetHasObject(key))) {
    return "skipped";
  }

  const object = await source.client.send(new GetObjectCommand({ Bucket: source.bucket, Key: key }));

  if (!object.Body) {
    throw new Error(`Source object has no body: ${key}`);
  }

  await target.client.send(
    new PutObjectCommand({
      Bucket: target.bucket,
      Key: key,
      Body: object.Body as Readable,
      ContentLength: object.ContentLength,
      ContentType: object.ContentType,
      CacheControl: object.CacheControl,
      ContentDisposition: object.ContentDisposition,
      ContentEncoding: object.ContentEncoding,
      ContentLanguage: object.ContentLanguage,
      Metadata: object.Metadata,
    }),
  );

  return "copied";
};

const migrate = async (): Promise<void> => {
  let continuationToken: string | undefined;
  let copied = 0;
  let skipped = 0;
  let discovered = 0;

  console.log(`Migrating ${source.bucket} -> ${target.bucket}`);

  do {
    const page = await source.client.send(
      new ListObjectsV2Command({
        Bucket: source.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents || []) {
      if (!item.Key) continue;

      discovered += 1;
      const result = await copyObject(item.Key);

      if (result === "copied") {
        copied += 1;
        console.log(`Copied: ${item.Key}`);
      } else {
        skipped += 1;
        console.log(`Skipped existing: ${item.Key}`);
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`Migration complete: ${discovered} found, ${copied} copied, ${skipped} skipped.`);
};

migrate().catch((error: unknown) => {
  console.error("Storage migration failed", error);
  process.exitCode = 1;
});
