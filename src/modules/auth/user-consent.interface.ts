import type { Types } from "mongoose";

export const userConsentContexts = ["signup"] as const;

export type UserConsentContext = (typeof userConsentContexts)[number];

export interface IUserConsent {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  context: UserConsentContext;
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: Date;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordUserConsentDto {
  userId: string;
  context: UserConsentContext;
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: Date;
  locale: string;
}
