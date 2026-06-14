import { Router } from "express";
import { catchAsync } from "../../core/http/catch-async.js";
import { authenticate } from "../../core/middlewares/auth.middleware.js";
import { validate } from "../../core/middlewares/validate.middleware.js";
import { CartController } from "./cart.controller.js";
import { cartValidation } from "./cart.validation.js";

const router = Router();
const controller = new CartController();

router.use(authenticate);

router.get("/", catchAsync(controller.getCart));
router.post("/items", validate(cartValidation.addItem), catchAsync(controller.addItem));
router.patch("/items/:productId", validate(cartValidation.updateItem), catchAsync(controller.updateItem));
router.delete("/items/:productId", validate(cartValidation.productParams), catchAsync(controller.removeItem));
router.delete("/", catchAsync(controller.clearCart));

export const cartRoutes = router;
