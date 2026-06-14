import type {
  IMoomentCreditPurchase,
  IMoomentCreditWallet,
  MoomentCreditPaymentMethod,
  MoomentCreditPurchaseStatus,
} from "./mooment-credit-payment.interface.js";
import { MoomentCreditPurchaseModel, MoomentCreditWalletModel } from "./mooment-credit-payment.model.js";

interface CreatePurchaseRecord {
  userId: string;
  packageId: string;
  packageName: string;
  credits: number;
  subtotalUsd: number;
  platformFeeUsd: number;
  taxPercent: number;
  taxUsd: number;
  totalUsd: number;
  paymentMethod: MoomentCreditPaymentMethod;
  status: MoomentCreditPurchaseStatus;
  paymentReference: string;
}

export class MoomentCreditPaymentRepository {
  public async findWalletByUserId(userId: string): Promise<IMoomentCreditWallet | null> {
    return MoomentCreditWalletModel.findOne({ userId });
  }

  public async ensureWallet(userId: string): Promise<IMoomentCreditWallet> {
    return MoomentCreditWalletModel.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, balance: 0 } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async incrementWallet(userId: string, credits: number): Promise<IMoomentCreditWallet> {
    return MoomentCreditWalletModel.findOneAndUpdate(
      { userId },
      {
        $inc: { balance: credits },
        $setOnInsert: { userId },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async decrementWallet(userId: string, credits: number): Promise<IMoomentCreditWallet | null> {
    return MoomentCreditWalletModel.findOneAndUpdate(
      { userId, balance: { $gte: credits } },
      { $inc: { balance: -credits } },
      { new: true, runValidators: true },
    );
  }

  public async createPurchase(payload: CreatePurchaseRecord): Promise<IMoomentCreditPurchase> {
    return MoomentCreditPurchaseModel.create(payload);
  }

  public async findPurchasesByUserId(userId: string, limit = 25): Promise<IMoomentCreditPurchase[]> {
    return MoomentCreditPurchaseModel.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }
}
