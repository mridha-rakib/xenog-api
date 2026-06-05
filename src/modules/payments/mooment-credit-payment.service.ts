import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { MoomentCreditService } from "../settings/mooment-credit.service.js";
import type { MoomentCreditPackageResponse } from "../settings/mooment-credit.interface.js";
import type {
  CreateMoomentCreditPurchaseDto,
  IMoomentCreditPurchase,
  IMoomentCreditWallet,
  MoomentCreditCheckoutQuote,
  MoomentCreditPurchaseResponse,
  MoomentCreditWalletResponse,
} from "./mooment-credit-payment.interface.js";
import { MoomentCreditPaymentRepository } from "./mooment-credit-payment.repository.js";

const roundCurrency = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export class MoomentCreditPaymentService {
  public constructor(
    private readonly repository = new MoomentCreditPaymentRepository(),
    private readonly moomentCreditService = new MoomentCreditService(),
  ) {}

  public async getCheckoutQuote(packageId: string): Promise<MoomentCreditCheckoutQuote> {
    const creditPackage = await this.findCreditPackage(packageId);

    return this.toCheckoutQuote(creditPackage);
  }

  public async purchaseCredits(
    user: AuthUser,
    payload: CreateMoomentCreditPurchaseDto,
  ): Promise<{ purchase: MoomentCreditPurchaseResponse; wallet: MoomentCreditWalletResponse }> {
    const quote = await this.getCheckoutQuote(payload.packageId);
    const purchase = await this.repository.createPurchase({
      userId: user.id,
      packageId: quote.creditPackage.id,
      packageName: quote.creditPackage.name,
      credits: quote.creditPackage.credits,
      subtotalUsd: quote.lineItems.subtotalUsd,
      platformFeeUsd: quote.lineItems.platformFeeUsd,
      taxPercent: quote.lineItems.taxPercent,
      taxUsd: quote.lineItems.taxUsd,
      totalUsd: quote.lineItems.totalUsd,
      paymentMethod: payload.paymentMethod,
      status: "completed",
      paymentReference: `mooment-credit-${randomUUID()}`,
    });
    const wallet = await this.repository.incrementWallet(user.id, quote.creditPackage.credits);
    const purchases = await this.repository.findPurchasesByUserId(user.id);

    return {
      purchase: this.toPurchaseResponse(purchase),
      wallet: this.toWalletResponse(wallet, purchases),
    };
  }

  public async getWallet(user: AuthUser): Promise<MoomentCreditWalletResponse> {
    const wallet = await this.repository.ensureWallet(user.id);
    const purchases = await this.repository.findPurchasesByUserId(user.id);

    return this.toWalletResponse(wallet, purchases);
  }

  private async findCreditPackage(packageId: string): Promise<MoomentCreditPackageResponse> {
    const settings = await this.moomentCreditService.getSettings();
    const creditPackage = settings.packages.find((pkg) => pkg.id === packageId);

    if (!creditPackage) {
      throw new AppError("Mooment credit package not found", httpStatus.NOT_FOUND);
    }

    return creditPackage;
  }

  private toCheckoutQuote(creditPackage: MoomentCreditPackageResponse): MoomentCreditCheckoutQuote {
    const totalUsd = roundCurrency(creditPackage.priceUsd);
    const taxPercent = creditPackage.commissionPercent;
    const subtotalUsd = taxPercent > 0 ? roundCurrency(totalUsd / (1 + taxPercent / 100)) : totalUsd;
    const platformFeeUsd = 0;
    const taxUsd = roundCurrency(totalUsd - subtotalUsd - platformFeeUsd);

    return {
      creditPackage,
      lineItems: {
        itemLabel: `${creditPackage.credits} Mooment Credits`,
        itemAmountUsd: totalUsd,
        subtotalUsd,
        platformFeeUsd,
        taxPercent,
        taxUsd,
        totalUsd,
      },
    };
  }

  private toWalletResponse(
    wallet: IMoomentCreditWallet,
    purchases: IMoomentCreditPurchase[],
  ): MoomentCreditWalletResponse {
    return {
      id: wallet._id.toString(),
      balance: wallet.balance,
      purchases: purchases.map((purchase) => this.toPurchaseResponse(purchase)),
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  private toPurchaseResponse(purchase: IMoomentCreditPurchase): MoomentCreditPurchaseResponse {
    return {
      id: purchase._id.toString(),
      packageId: purchase.packageId,
      packageName: purchase.packageName,
      credits: purchase.credits,
      subtotalUsd: purchase.subtotalUsd,
      platformFeeUsd: purchase.platformFeeUsd,
      taxPercent: purchase.taxPercent,
      taxUsd: purchase.taxUsd,
      totalUsd: purchase.totalUsd,
      paymentMethod: purchase.paymentMethod,
      status: purchase.status,
      paymentReference: purchase.paymentReference,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    };
  }
}
