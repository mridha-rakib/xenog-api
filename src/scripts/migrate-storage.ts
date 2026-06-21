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

const createEndpoint = (host: string, port: string, useSsl: boolean): string => {
  const protocol = useSsl ? "https" : "http";
  const isDefaultPort = (useSsl && port === "443") || (!useSsl && port === "80");
  return `${protocol}://${host}${isDefaultPort ? "" : `:${port}`}`;
};

const createClient = (
  endpoint: string,
  accessKeyId: string,
  secretAccessKey: string,
): S3Client => {
  const config: S3ClientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  };

  return new S3Client(config);
};

const sourceEndpoint = createEndpoint(
  required("SOURCE_MINIO_ENDPOINT", "MINIO_ENDPOINT"),
  process.env.SOURCE_MINIO_PORT || process.env.MINIO_PORT || "9000",
  asBoolean(process.env.SOURCE_MINIO_USE_SSL, asBoolean(process.env.MINIO_USE_SSL)),
);

const targetEndpoint = createEndpoint(
  required("TARGET_MINIO_ENDPOINT"),
  process.env.TARGET_MINIO_PORT || "443",
  asBoolean(process.env.TARGET_MINIO_USE_SSL, true),
);

const source: StorageConfig = {
  bucket: required("SOURCE_MINIO_BUCKET", "MINIO_BUCKET"),
  client: createClient(
    sourceEndpoint,
    required("SOURCE_MINIO_ACCESS_KEY", "MINIO_ACCESS_KEY"),
    required("SOURCE_MINIO_SECRET_KEY", "MINIO_SECRET_KEY"),
  ),
};

const target: StorageConfig = {
  bucket: process.env.TARGET_MINIO_BUCKET || source.bucket,
  client: createClient(
    targetEndpoint,
    required("TARGET_MINIO_ACCESS_KEY"),
    required("TARGET_MINIO_SECRET_KEY"),
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

  console.log(`Migrating ${source.bucket} (${sourceEndpoint}) -> ${target.bucket} (${targetEndpoint})`);

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
