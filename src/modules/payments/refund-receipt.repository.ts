import type { UpdateQuery } from "mongoose";
import type {
  IRefundReceipt,
  RefundReceiptSnapshot,
  RefundReceiptSourceType,
} from "./refund-receipt.interface.js";
import { RefundReceiptModel } from "./refund-receipt.model.js";

const STALE_LOCK_MS = 15 * 60 * 1000;

export class RefundReceiptRepository {
  public async createOrGet(payload: {
    idempotencyKey: string;
    sourceType: RefundReceiptSourceType;
    sourceRefundId: string;
    payerUserId: string;
    toEmail: string;
    receiptReference: string;
    orderReference: string;
    snapshot: RefundReceiptSnapshot;
  }): Promise<IRefundReceipt> {
    return RefundReceiptModel.findOneAndUpdate(
      { idempotencyKey: payload.idempotencyKey },
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

  public async findByIdempotencyKey(idempotencyKey: string): Promise<IRefundReceipt | null> {
    return RefundReceiptModel.findOne({ idempotencyKey });
  }

  public async claimDue(limit = 20): Promise<IRefundReceipt[]> {
    const claimed: IRefundReceipt[] = [];
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);

    for (let index = 0; index < limit; index += 1) {
      const receipt = await RefundReceiptModel.findOneAndUpdate(
        {
          $or: [
            {
              status: { $in: ["pending", "failed_retryable"] },
              $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
            },
            { status: "sending", lockedAt: { $lte: staleBefore } },
          ],
        },
        {
          $set: { status: "sending", lockedAt: now },
          $inc: { attemptCount: 1 },
        },
        { new: true, sort: { nextRetryAt: 1, createdAt: 1 }, runValidators: true },
      );

      if (!receipt) break;
      claimed.push(receipt);
    }

    return claimed;
  }

  public async update(id: string, update: UpdateQuery<IRefundReceipt>): Promise<IRefundReceipt | null> {
    return RefundReceiptModel.findByIdAndUpdate(id, update, { new: true, runValidators: true });
  }
}
