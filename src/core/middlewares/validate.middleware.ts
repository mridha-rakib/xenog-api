import type { RequestHandler } from "express";
import type { AnyZodObject, ZodEffects } from "zod";
import httpStatus from "http-status";
import { AppError } from "../errors/app-error.js";
import { formatZodError } from "../validation/zod-error.formatter.js";

type ValidationSchema = AnyZodObject | ZodEffects<AnyZodObject>;

export const validate =
  (schema: ValidationSchema): RequestHandler =>
  async (req, _res, next) => {
    const result = await schema.safeParseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      next(new AppError("Validation failed", httpStatus.BAD_REQUEST, formatZodError(result.error)));
      return;
    }

    req.body = result.data.body ?? req.body;
    req.query = result.data.query ?? req.query;
    req.params = result.data.params ?? req.params;

    next();
  };
