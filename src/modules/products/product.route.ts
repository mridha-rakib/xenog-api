import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { ProductController } from "./product.controller.js";
import { productValidation } from "./product.validation.js";

const router = Router();
const controller = new ProductController();

router.use(authenticate);

router.post(
  "/",
  validate(productValidation.createProduct),
  catchAsync(controller.createProduct),
);

router.get("/mine", catchAsync(controller.listMyProducts));
router.get("/:id", validate(productValidation.productParams), catchAsync(controller.getMyProduct));
router.patch("/:id", validate(productValidation.updateProduct), catchAsync(controller.updateMyProduct));
router.delete("/:id", validate(productValidation.productParams), catchAsync(controller.deleteMyProduct));

export const productRoutes = router;
