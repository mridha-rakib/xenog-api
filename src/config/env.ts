import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  API_PREFIX: z.string().default("/api/v1"),
  PUBLIC_API_PREFIX: z.string().optional(),

  APP_NAME: z.string().default("Spark Tech API"),
  APP_ORIGIN: z.string().default("http://localhost:3000"),
  CORS_ORIGIN: z.string().optional(),
  LOGGER_PROVIDER: z.string().default("pino"),
  LOG_LEVEL: z.string().default("info"),
  REQUEST_BODY_LIMIT_MB: z.coerce.number().int().positive().default(2),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, "AWS_SECRET_ACCESS_KEY is required"),
  AWS_S3_BUCKET: z.string().min(1, "AWS_S3_BUCKET is required"),
  AWS_S3_PUBLIC_BASE_URL: z.string().url().optional(),

  JWT_ACCESS_SECRET: z.string().min(32).default("development-access-secret-change-before-production"),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  JWT_ACCESS_EXPIRES_IN: z.string().optional(),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  ADMIN_DISPLAY_NAME: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CURRENCY: z.string().default("usd"),
  STRIPE_MERCHANT_COUNTRY: z.string().default("US"),
  STRIPE_CONNECT_RETURN_URL: z.string().optional(),
  STRIPE_CONNECT_REFRESH_URL: z.string().optional(),
  STRIPE_CONNECT_APP_RETURN_URL: z.string().optional(),
  STRIPE_CONNECT_APP_REFRESH_URL: z.string().optional(),
  STRIPE_CONNECT_ALLOW_CLIENT_REDIRECTS: z
    .string()
    .optional()
    .transform((value) => (value ? value === "true" : undefined)),

  AI_ENGINE_MODE: z.string().default("rules"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
});

export const env = envSchema.parse(process.env);
