import type { UpdateQuery } from "mongoose";
import type { CheckoutInvoiceSnapshot, ICheckoutInvoice } from "./checkout-invoice.interface.js";
import { CheckoutInvoiceModel } from "./checkout-invoice.model.js";

export class CheckoutInvoiceRepository {
  public async createOrGet(payload: {
    orderId: string;
    userId: string;
    invoiceNumber: string;
    toEmail: string;
    snapshot: CheckoutInvoiceSnapshot;
  }): Promise<ICheckoutInvoice> {
    return CheckoutInvoiceModel.findOneAndUpdate(
      { orderId: payload.orderId },
      {
        $setOnInsert: {
          ...payload,
          status: "pending",
          attemptCount: 0,
          nextRetryAt: new Date(),
        },
      },
      { new: true, upsert: true, runValidators: true },
    );
  }

  public async claimDue(limit = 20): Promise<ICheckoutInvoice[]> {
    const claimed: ICheckoutInvoice[] = [];
    const now = new Date();

    for (let index = 0; index < limit; index += 1) {
      const invoice = await CheckoutInvoiceModel.findOneAndUpdate(
        {
          status: { $in: ["pending", "failed_retryable"] },
          $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
        },
        {
          $set: { status: "sending", lockedAt: now },
          $inc: { attemptCount: 1 },
        },
        { new: true, sort: { nextRetryAt: 1, createdAt: 1 }, runValidators: true },
      );

      if (!invoice) break;
      claimed.push(invoice);
    }

    return claimed;
  }

  public async update(id: string, update: UpdateQuery<ICheckoutInvoice>): Promise<ICheckoutInvoice | null> {
    return CheckoutInvoiceModel.findByIdAndUpdate(id, update, { new: true, runValidators: true });
  }
}
