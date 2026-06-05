import { Schema, model } from "mongoose";
import type { ILegalDocument, ILegalDocumentClause } from "./legal-document.interface.js";
import { legalDocumentTypes } from "./legal-document.interface.js";

const legalDocumentClauseSchema = new Schema<ILegalDocumentClause>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20000,
    },
    sortOrder: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: false,
  },
);

const legalDocumentSchema = new Schema<ILegalDocument>(
  {
    type: {
      type: String,
      enum: legalDocumentTypes,
      required: true,
      unique: true,
      index: true,
    },
    clauses: {
      type: [legalDocumentClauseSchema],
      default: [],
    },
    displayOnLandingPage: {
      type: Boolean,
      default: true,
    },
    lastModifiedBy: {
      id: {
        type: String,
        trim: true,
      },
      name: {
        type: String,
        trim: true,
      },
      email: {
        type: String,
        trim: true,
        lowercase: true,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const LegalDocumentModel = model<ILegalDocument>("LegalDocument", legalDocumentSchema);
