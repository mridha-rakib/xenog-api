import express, { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { StorageController } from "./storage.controller.js";
import { storageValidation } from "./storage.validation.js";

const router = Router();
const controller = new StorageController();

router.post(
  "/upload-url",
  validate(storageValidation.createUploadUrl),
  catchAsync(controller.createUploadUrl),
);
router.get(
  "/download-url/:key",
  validate(storageValidation.createDownloadUrl),
  catchAsync(controller.createDownloadUrl),
);
router.put(
  "/upload",
  validate(storageValidation.storageKeyQuery),
  express.raw({ type: "*/*", limit: "300mb" }),
  catchAsync(controller.uploadFile),
);
router.get(
  "/file",
  validate(storageValidation.storageKeyQuery),
  catchAsync(controller.streamFile),
);
router.get(
  "/file/:filename",
  validate(storageValidation.storageKeyQuery),
  catchAsync(controller.streamFile),
);

export const storageRoutes = router;
