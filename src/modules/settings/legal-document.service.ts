import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { LegalDocumentRepository } from "./legal-document.repository.js";
import type {
  ILegalDocument,
  LegalDocumentModifier,
  LegalDocumentResponse,
  LegalDocumentType,
  UpdateLegalDocumentDto,
} from "./legal-document.interface.js";

const legalDocumentCopy: Record<LegalDocumentType, { title: string; subtitle: string }> = {
  terms: {
    title: "Terms & Conditions",
    subtitle: "Set terms & conditions of your Mooment app",
  },
  privacy: {
    title: "Privacy & Policy",
    subtitle: "Set privacy & policy of your Mooment app",
  },
};

const defaultLegalClauses: Record<LegalDocumentType, UpdateLegalDocumentDto["clauses"]> = {
  terms: [
    {
      title: "Introduction",
      body: "Our platform unifies all customer communication channels: WhatsApp, Twilio (SMS), and Gmail into a single shared inbox. Teams can collaborate, assign conversations, and respond to customers without switching tools, making customer support faster, simpler, and more organized.",
      sortOrder: 0,
    },
  ],
  privacy: [
    {
      title: "Data Collection",
      body: "We value your privacy and are committed to protecting your personal data. This policy outlines how we collect, use, and safeguard your information when you use our Mooment application and services.",
      sortOrder: 0,
    },
  ],
};

export class LegalDocumentService {
  public constructor(private readonly legalDocumentRepository = new LegalDocumentRepository()) {}

  public async getDocument(type: LegalDocumentType, adminUser?: AuthUser): Promise<LegalDocumentResponse> {
    const document = await this.legalDocumentRepository.findByType(type);

    if (document) {
      return this.toResponse(document);
    }

    const createdDocument = await this.legalDocumentRepository.create(type, {
      clauses: defaultLegalClauses[type],
      displayOnLandingPage: true,
      modifiedBy: adminUser ? this.toModifier(adminUser) : this.getSystemModifier(),
    });

    return this.toResponse(createdDocument);
  }

  public async updateDocument(
    type: LegalDocumentType,
    payload: UpdateLegalDocumentDto,
    adminUser: AuthUser,
  ): Promise<LegalDocumentResponse> {
    const normalizedPayload: UpdateLegalDocumentDto = {
      displayOnLandingPage: payload.displayOnLandingPage ?? true,
      clauses: payload.clauses.map((clause, index) => ({
        ...clause,
        title: clause.title.trim(),
        body: clause.body.trim(),
        sortOrder: clause.sortOrder ?? index,
      })),
    };

    const existingDocument = await this.legalDocumentRepository.findByType(type);
    const document = existingDocument
      ? await this.legalDocumentRepository.updateByType(type, {
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        })
      : await this.legalDocumentRepository.create(type, {
          ...normalizedPayload,
          modifiedBy: this.toModifier(adminUser),
        });

    if (!document) {
      throw new AppError("Legal document could not be saved", httpStatus.INTERNAL_SERVER_ERROR);
    }

    return this.toResponse(document);
  }

  private toModifier(adminUser: AuthUser): LegalDocumentModifier {
    return {
      id: adminUser.id,
      name: adminUser.name,
      email: adminUser.email,
    };
  }

  private getSystemModifier(): LegalDocumentModifier {
    return {
      id: "system",
      name: "Admin",
      email: "admin@moment.com",
    };
  }

  private toResponse(document: ILegalDocument): LegalDocumentResponse {
    const copy = legalDocumentCopy[document.type];

    return {
      id: document._id.toString(),
      type: document.type,
      title: copy.title,
      subtitle: copy.subtitle,
      clauses: document.clauses
        .map((clause) => ({
          id: clause._id.toString(),
          title: clause.title,
          body: clause.body,
          sortOrder: clause.sortOrder,
        }))
        .sort((left, right) => left.sortOrder - right.sortOrder),
      displayOnLandingPage: document.displayOnLandingPage,
      lastModifiedBy: document.lastModifiedBy,
      lastModifiedAt: document.updatedAt,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }
}
