import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { LegalDocumentService } from "./legal-document.service.js";
import type { LegalDocumentType } from "./legal-document.interface.js";
import { MoomentCreditService } from "./mooment-credit.service.js";
import { PricingSettingsService } from "./pricing-settings.service.js";

export class SettingsController {
  public constructor(
    private readonly legalDocumentService = new LegalDocumentService(),
    private readonly moomentCreditService = new MoomentCreditService(),
    private readonly pricingSettingsService = new PricingSettingsService(),
  ) {}

  public getLegalDocument = async (req: Request, res: Response): Promise<void> => {
    const { type } = req.params as { type: LegalDocumentType };
    const document = await this.legalDocumentService.getDocument(type, req.authUser);

    ApiResponse.success(res, {
      message: "Legal document retrieved",
      data: {
        document,
      },
    });
  };

  public updateLegalDocument = async (req: Request, res: Response): Promise<void> => {
    const { type } = req.params as { type: LegalDocumentType };
    const document = await this.legalDocumentService.updateDocument(type, req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Legal document updated",
      data: {
        document,
      },
    });
  };

  public getMoomentCreditSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.moomentCreditService.getSettings(req.authUser);

    ApiResponse.success(res, {
      message: "Mooment credit settings retrieved",
      data: {
        settings,
      },
    });
  };

  public updateMoomentCreditSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.moomentCreditService.updateSettings(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Mooment credit settings updated",
      data: {
        settings,
      },
    });
  };

  public getPricingSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.pricingSettingsService.getSettings(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Pricing settings retrieved",
      data: {
        settings,
      },
    });
  };

  public updatePricingSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.pricingSettingsService.updateSettings(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Pricing settings updated",
      data: {
        settings,
      },
    });
  };
}
