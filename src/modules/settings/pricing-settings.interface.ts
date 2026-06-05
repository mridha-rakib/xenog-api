import type { Types } from "mongoose";
import type { LegalDocumentModifier } from "./legal-document.interface.js";

export interface IPricingSettingsValues {
  tax: number;
  creditCardFee: number;
  applePayoutFee: number;
  platformFee: number;
  productPercentage: number;
  ticketPercentage: number;
}

export interface IPricingSettings extends IPricingSettingsValues {
  _id: Types.ObjectId;
  key: "pricing";
  lastModifiedBy?: LegalDocumentModifier;
  createdAt: Date;
  updatedAt: Date;
}

export type UpdatePricingSettingsDto = IPricingSettingsValues;

export interface PricingSettingsResponse extends IPricingSettingsValues {
  id: string;
  title: string;
  subtitle: string;
  lastModifiedBy?: LegalDocumentModifier;
  lastModifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
