import { LegalDocumentModel } from "./legal-document.model.js";
import type {
  ILegalDocument,
  LegalDocumentModifier,
  LegalDocumentType,
  UpdateLegalDocumentDto,
} from "./legal-document.interface.js";

interface SaveLegalDocumentPayload extends UpdateLegalDocumentDto {
  modifiedBy: LegalDocumentModifier;
}

export class LegalDocumentRepository {
  public async findByType(type: LegalDocumentType): Promise<ILegalDocument | null> {
    return LegalDocumentModel.findOne({ type });
  }

  public async create(
    type: LegalDocumentType,
    payload: SaveLegalDocumentPayload,
  ): Promise<ILegalDocument> {
    return LegalDocumentModel.create({
      type,
      clauses: this.mapClausesForPersistence(payload.clauses),
      displayOnLandingPage: payload.displayOnLandingPage ?? true,
      lastModifiedBy: payload.modifiedBy,
    });
  }

  public async updateByType(
    type: LegalDocumentType,
    payload: SaveLegalDocumentPayload,
  ): Promise<ILegalDocument | null> {
    return LegalDocumentModel.findOneAndUpdate(
      { type },
      {
        $set: {
          clauses: this.mapClausesForPersistence(payload.clauses),
          displayOnLandingPage: payload.displayOnLandingPage ?? true,
          lastModifiedBy: payload.modifiedBy,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  private mapClausesForPersistence(clauses: UpdateLegalDocumentDto["clauses"]) {
    return clauses.map((clause, index) => ({
      ...(clause.id ? { _id: clause.id } : {}),
      title: clause.title,
      body: clause.body,
      sortOrder: clause.sortOrder ?? index,
    }));
  }
}
