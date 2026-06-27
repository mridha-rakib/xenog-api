/**
 * One-time migration: populate availableCount on all published/live/completed event tickets.
 *
 * For each event that is not draft/cancelled, sets:
 *   availableCount = max(0, capacity - soldCount)
 *
 * where soldCount is the total quantity from paid CheckoutOrders for that ticket.
 *
 * Run once after deploying the availableCount schema change, before enabling
 * the new atomic reservation logic.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-ticket-available-count.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { EventModel } from "../modules/events/event.model.js";
import { CheckoutOrderModel } from "../modules/payments/checkout-payment.model.js";

const migrate = async (): Promise<void> => {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const targetStatuses = ["published", "live", "completed"];
  const events = await EventModel.find({ status: { $in: targetStatuses } }).lean();

  console.log(`Found ${events.length} events to migrate`);

  let updated = 0;
  let skipped = 0;

  for (const event of events) {
    const eventId = event._id.toString();

    // Count sold tickets per ticketId from paid orders
    const paidOrders = await CheckoutOrderModel.find({
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
    })
      .select("lineItems")
      .lean();

    const soldByTicketId: Record<string, number> = {};

    for (const order of paidOrders) {
      for (const item of order.lineItems) {
        if (item.itemId && item.eventId === eventId) {
          const qty = item.totalQuantity ?? (item.paidQuantity ?? item.quantity) + (item.freeQuantity ?? 0);
          soldByTicketId[item.itemId] = (soldByTicketId[item.itemId] ?? 0) + qty;
        }
      }
    }

    // Build atomic update for each ticket
    const bulkOps = event.tickets.map((ticket) => {
      const sold = soldByTicketId[ticket.id] ?? 0;
      const availableCount = Math.max(0, ticket.capacity - sold);

      return {
        updateOne: {
          filter: {
            _id: event._id,
            "tickets.id": ticket.id,
          },
          update: {
            $set: { "tickets.$.availableCount": availableCount },
          },
        },
      };
    });

    if (bulkOps.length === 0) {
      skipped++;
      continue;
    }

    await EventModel.bulkWrite(bulkOps);
    updated++;

    if (updated % 100 === 0) {
      console.log(`Migrated ${updated} events...`);
    }
  }

  console.log(`Migration complete. Updated: ${updated}, Skipped (no tickets): ${skipped}`);
  await mongoose.disconnect();
};

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
