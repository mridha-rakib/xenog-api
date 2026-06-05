import type { LegalDocumentModifier } from "./legal-document.interface.js";
import type { IMoomentCreditSettings, UpdateMoomentCreditSettingsDto } from "./mooment-credit.interface.js";
import { MoomentCreditSettingsModel } from "./mooment-credit.model.js";

interface SaveMoomentCreditSettingsPayload extends UpdateMoomentCreditSettingsDto {
  modifiedBy?: LegalDocumentModifier;
}

export class MoomentCreditRepository {
  public async find(): Promise<IMoomentCreditSettings | null> {
    return MoomentCreditSettingsModel.findOne({ key: "mooment-credit" });
  }

  public async create(payload: SaveMoomentCreditSettingsPayload): Promise<IMoomentCreditSettings> {
    return MoomentCreditSettingsModel.create({
      key: "mooment-credit",
      packages: this.mapPackagesForPersistence(payload.packages),
      ...(payload.modifiedBy ? { lastModifiedBy: payload.modifiedBy } : {}),
    });
  }

  public async update(payload: SaveMoomentCreditSettingsPayload): Promise<IMoomentCreditSettings | null> {
    return MoomentCreditSettingsModel.findOneAndUpdate(
      { key: "mooment-credit" },
      {
        $set: {
          packages: this.mapPackagesForPersistence(payload.packages),
          lastModifiedBy: payload.modifiedBy,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  private mapPackagesForPersistence(packages: UpdateMoomentCreditSettingsDto["packages"]) {
    return packages.map((pkg, index) => ({
      ...(pkg.id ? { _id: pkg.id } : {}),
      name: pkg.name,
      credits: pkg.credits,
      priceUsd: pkg.priceUsd,
      commissionPercent: pkg.commissionPercent,
      sortOrder: pkg.sortOrder ?? index,
    }));
  }
}
