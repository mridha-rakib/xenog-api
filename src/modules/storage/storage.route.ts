import { Router } from "express";
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

export const storageRoutes = router;
