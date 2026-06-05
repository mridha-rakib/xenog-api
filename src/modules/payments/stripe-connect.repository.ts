import { Types } from "mongoose";
import type { IStripeConnectAccount } from "./stripe-connect.interface.js";
import { StripeConnectAccountModel } from "./stripe-connect.model.js";

type UpsertStripeConnectAccountPayload = Omit<
  Partial<IStripeConnectAccount>,
  "_id" | "userId" | "createdAt" | "updatedAt"
> & {
  userId: string;
  stripeAccountId: string;
};

export class StripeConnectRepository {
  public async findByUserId(userId: string): Promise<IStripeConnectAccount | null> {
    return StripeConnectAccountModel.findOne({ userId });
  }

  public async upsertByUserId(payload: UpsertStripeConnectAccountPayload): Promise<IStripeConnectAccount> {
    const { userId, ...update } = payload;

    return StripeConnectAccountModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      {
        $set: update,
        $setOnInsert: {
          userId: new Types.ObjectId(userId),
        },
      },
      { new: true, upsert: true, runValidators: true },
    );
  }
}
