import type { Types } from "mongoose";

export const legalDocumentTypes = ["terms", "privacy"] as const;

export type LegalDocumentType = (typeof legalDocumentTypes)[number];

export interface LegalDocumentModifier {
  id: string;
  name: string;
  email: string;
}

export interface ILegalDocumentClause {
  _id: Types.ObjectId;
  title: string;
  body: string;
  sortOrder: number;
}

export interface ILegalDocument {
  _id: Types.ObjectId;
  type: LegalDocumentType;
  clauses: ILegalDocumentClause[];
  displayOnLandingPage: boolean;
  lastModifiedBy?: LegalDocumentModifier;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegalDocumentClauseInput {
  id?: string;
  title: string;
  body: string;
  sortOrder?: number;
}

export interface UpdateLegalDocumentDto {
  clauses: LegalDocumentClauseInput[];
  displayOnLandingPage?: boolean;
}

export interface LegalDocumentClauseResponse {
  id: string;
  title: string;
  body: string;
  sortOrder: number;
}

export interface LegalDocumentResponse {
  id: string;
  type: LegalDocumentType;
  title: string;
  subtitle: string;
  clauses: LegalDocumentClauseResponse[];
  displayOnLandingPage: boolean;
  lastModifiedBy?: LegalDocumentModifier;
  lastModifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
