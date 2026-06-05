import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { LegalDocumentModifier } from "./legal-document.interface.js";
import { MoomentCreditRepository } from "./mooment-credit.repository.js";
import type {
  IMoomentCreditSettings,
  MoomentCreditSettingsResponse,
  UpdateMoomentCreditSettingsDto,
} from "./mooment-credit.interface.js";

const defaultCreditPackages: UpdateMoomentCreditSettingsDto["packages"] = [
  {
    name: "25 Mooments credit for",
    credits: 25,
    priceUsd: 26.25,
    commissionPercent: 5,
    sortOrder: 0,
  },
  {
    name: "50 Mooments credit for",
    credits: 50,
    priceUsd: 52.5,
    commissionPercent: 5,
    sortOrder: 1,
  },
  {
    name: "100 Mooments credit for",
    credits: 100,
    priceUsd: 105,
    commissionPercent: 5,
    sortOrder: 2,
  },
  {
    name: "250 Mooments credit for",
    credits: 250,
    priceUsd: 262.5,
    commissionPercent: 5,
    sortOrder: 3,
  },
  {
    name: "500 Mooments credit for",
    credits: 500,
    priceUsd: 525,
    commissionPercent: 5,
    sortOrder: 4,
  },
];

export class MoomentCreditService {
  public constructor(private readonly moomentCreditRepository = new MoomentCreditRepository()) {}

  public async getSettings(adminUser?: AuthUser): Promise<MoomentCreditSettingsResponse> {
    const settings = await this.moomentCreditRepository.find();

    if (settings) {
      return this.toResponse(settings);
    }

    const createdSettings = await this.moomentCreditRepository.create({
      packages: defaultCreditPackages,
      ...(adminUser ? { modifiedBy: this.toModifier(adminUser) } : {}),
    });

    return this.toResponse(createdSettings);
  }

  public async updateSettings(
    payload: UpdateMoomentCreditSettingsDto,
    adminUser: AuthUser,
  ): Promise<MoomentCreditSettingsResponse> {
    const normalizedPayload: UpdateMoomentCreditSettingsDto = {
      packages: payload.packages.map((pkg, index) => ({
        ...pkg,
        name: pkg.name.trim(),
        credits: pkg.credits,
        priceUsd: pkg.priceUsd,
        commissionPercent: pkg.commissionPercent,
        sortOrder: pkg.sortOrder ?? index,
      })),
    };

    const existingSettings = await this.moomentCreditRepository.find();
    const settings = existingSettings
      ? await this.moomentCreditRepository.update({
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        })
      : await this.moomentCreditRepository.create({
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        });

    if (!settings) {
      throw new AppError("Mooment credit settings could not be saved", httpStatus.INTERNAL_SERVER_ERROR);
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

  private toResponse(settings: IMoomentCreditSettings): MoomentCreditSettingsResponse {
    return {
      id: settings._id.toString(),
      title: "Mooment Credit",
      subtitle: "Manage Mooment credit of your app",
      packages: settings.packages
        .map((pkg) => ({
          id: pkg._id.toString(),
          name: pkg.name,
          credits: pkg.credits,
          priceUsd: pkg.priceUsd,
          commissionPercent: pkg.commissionPercent,
          sortOrder: pkg.sortOrder,
        }))
        .sort((left, right) => left.sortOrder - right.sortOrder),
      lastModifiedBy: settings.lastModifiedBy,
      lastModifiedAt: settings.updatedAt,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }
}
