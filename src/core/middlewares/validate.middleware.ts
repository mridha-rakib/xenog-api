import type { RequestHandler } from "express";
import type { AnyZodObject, ZodEffects } from "zod";

type ValidationSchema = AnyZodObject | ZodEffects<AnyZodObject>;

export const validate =
  (schema: ValidationSchema): RequestHandler =>
  (req, _res, next) => {
    const result = schema.parse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    req.body = result.body ?? req.body;
    req.query = result.query ?? req.query;
    req.params = result.params ?? req.params;

    next();
  };
