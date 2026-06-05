import type { LegalDocumentModifier } from "./legal-document.interface.js";
import type { IPricingSettings, UpdatePricingSettingsDto } from "./pricing-settings.interface.js";
import { PricingSettingsModel } from "./pricing-settings.model.js";

interface SavePricingSettingsPayload extends UpdatePricingSettingsDto {
  modifiedBy: LegalDocumentModifier;
}

export class PricingSettingsRepository {
  public async find(): Promise<IPricingSettings | null> {
    return PricingSettingsModel.findOne({ key: "pricing" });
  }

  public async create(payload: SavePricingSettingsPayload): Promise<IPricingSettings> {
    return PricingSettingsModel.create({
      key: "pricing",
      ...this.mapValuesForPersistence(payload),
      lastModifiedBy: payload.modifiedBy,
    });
  }

  public async update(payload: SavePricingSettingsPayload): Promise<IPricingSettings | null> {
    return PricingSettingsModel.findOneAndUpdate(
      { key: "pricing" },
      {
        $set: {
          ...this.mapValuesForPersistence(payload),
          lastModifiedBy: payload.modifiedBy,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  private mapValuesForPersistence(payload: UpdatePricingSettingsDto): UpdatePricingSettingsDto {
    return {
      tax: payload.tax,
      creditCardFee: payload.creditCardFee,
      applePayoutFee: payload.applePayoutFee,
      platformFee: payload.platformFee,
      productPercentage: payload.productPercentage,
      ticketPercentage: payload.ticketPercentage,
    };
  }
}
