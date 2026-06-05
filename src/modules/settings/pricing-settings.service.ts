import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { LegalDocumentModifier } from "./legal-document.interface.js";
import type {
  IPricingSettings,
  PricingSettingsResponse,
  UpdatePricingSettingsDto,
} from "./pricing-settings.interface.js";
import { PricingSettingsRepository } from "./pricing-settings.repository.js";

const defaultPricingSettings: UpdatePricingSettingsDto = {
  tax: 5,
  creditCardFee: 5,
  applePayoutFee: 5,
  platformFee: 5,
  productPercentage: 5,
  ticketPercentage: 5,
};

export class PricingSettingsService {
  public constructor(private readonly pricingSettingsRepository = new PricingSettingsRepository()) {}

  public async getSettings(adminUser: AuthUser): Promise<PricingSettingsResponse> {
    const settings = await this.pricingSettingsRepository.find();

    if (settings) {
      return this.toResponse(settings);
    }

    const createdSettings = await this.pricingSettingsRepository.create({
      ...defaultPricingSettings,
      modifiedBy: this.toModifier(adminUser),
    });

    return this.toResponse(createdSettings);
  }

  public async updateSettings(
    payload: UpdatePricingSettingsDto,
    adminUser: AuthUser,
  ): Promise<PricingSettingsResponse> {
    const normalizedPayload: UpdatePricingSettingsDto = {
      tax: payload.tax,
      creditCardFee: payload.creditCardFee,
      applePayoutFee: payload.applePayoutFee,
      platformFee: payload.platformFee,
      productPercentage: payload.productPercentage,
      ticketPercentage: payload.ticketPercentage,
    };

    const existingSettings = await this.pricingSettingsRepository.find();
    const settings = existingSettings
      ? await this.pricingSettingsRepository.update({
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        })
      : await this.pricingSettingsRepository.create({
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        });

    if (!settings) {
      throw new AppError("Pricing settings could not be saved", httpStatus.INTERNAL_SERVER_ERROR);
    }

    return this.toResponse(settings);
  }

  private toModifier(adminUser: AuthUser): LegalDocumentModifier {
    return {
      id: adminUser.id,
      name: adminUser.name,
      email: adminUser.email,
    };
  }

  private toResponse(settings: IPricingSettings): PricingSettingsResponse {
    return {
      id: settings._id.toString(),
      title: "Pricing",
      subtitle: "Manage pricing of your app",
      tax: settings.tax,
      creditCardFee: settings.creditCardFee,
      applePayoutFee: settings.applePayoutFee,
      platformFee: settings.platformFee,
      productPercentage: settings.productPercentage,
      ticketPercentage: settings.ticketPercentage,
      lastModifiedBy: settings.lastModifiedBy,
      lastModifiedAt: settings.updatedAt,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }
}
