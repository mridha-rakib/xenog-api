import { Router } from "express";
import { chatRoutes } from "../modules/chat/chat.route.js";
import { eventRoutes } from "../modules/events/event.route.js";
import { healthRoutes } from "../modules/health/health.route.js";
import { liveRoomRoutes } from "../modules/live-rooms/live-room.route.js";
import { storageRoutes } from "../modules/storage/storage.route.js";
import { userRoutes } from "../modules/user/user.route.js";
import { authRoutes } from "../modules/auth/auth.route.js";
import { paymentRoutes } from "../modules/payments/payment.route.js";
import { planRoutes } from "../modules/plans/plan.route.js";
import { productRoutes } from "../modules/products/product.route.js";
import { settingsRoutes } from "../modules/settings/settings.route.js";
import { storyRoutes } from "../modules/stories/story.route.js";
import { supportTicketRoutes } from "../modules/support/support-ticket.route.js";
import { momentRoutes } from "../modules/moments/moment.route.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/chat", chatRoutes);
router.use("/events", eventRoutes);
router.use("/health", healthRoutes);
router.use("/live-rooms", liveRoomRoutes);
router.use("/moments", momentRoutes);
router.use("/payments", paymentRoutes);
router.use("/plans", planRoutes);
router.use("/products", productRoutes);
router.use("/storage", storageRoutes);
router.use("/settings", settingsRoutes);
router.use("/stories", storyRoutes);
router.use("/support", supportTicketRoutes);
router.use("/users", userRoutes);

export const appRoutes = router;
