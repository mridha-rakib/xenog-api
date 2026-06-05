import type { Types } from "mongoose";
import type { LegalDocumentModifier } from "./legal-document.interface.js";

export interface IMoomentCreditPackage {
  _id: Types.ObjectId;
  name: string;
  credits: number;
  priceUsd: number;
  commissionPercent: number;
  sortOrder: number;
}

export interface IMoomentCreditSettings {
  _id: Types.ObjectId;
  key: "mooment-credit";
  packages: IMoomentCreditPackage[];
  lastModifiedBy?: LegalDocumentModifier;
  createdAt: Date;
  updatedAt: Date;
}

export interface MoomentCreditPackageInput {
  id?: string;
  name: string;
  credits: number;
  priceUsd: number;
  commissionPercent: number;
  sortOrder?: number;
}

export interface UpdateMoomentCreditSettingsDto {
  packages: MoomentCreditPackageInput[];
}

export interface MoomentCreditPackageResponse {
  id: string;
  name: string;
  credits: number;
  priceUsd: number;
  commissionPercent: number;
  sortOrder: number;
}

export interface MoomentCreditSettingsResponse {
  id: string;
  title: string;
  subtitle: string;
  packages: MoomentCreditPackageResponse[];
  lastModifiedBy?: LegalDocumentModifier;
  lastModifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
