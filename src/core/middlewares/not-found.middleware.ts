import type { RequestHandler } from "express";
import httpStatus from "http-status";
import { AppError } from "../errors/app-error.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, httpStatus.NOT_FOUND));
};
