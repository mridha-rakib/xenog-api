import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type { IBusinessProfileSettings } from "../user/user.interface.js";
import { StripeConnectService } from "./stripe-connect.service.js";
import type { PayoutSettingsView, UpdatePayoutSettingsDto } from "./payout-settings.interface.js";

const BUSINESS_ONLY_ERROR = "Payout settings are only available for business accounts";

const resolveInstantEligible = async (
  userId: string,
  stripeConnectService: StripeConnectService,
): Promise<boolean> => {
  try {
    const account = await stripeConnectService.getAccount(userId);

    if (!account?.payoutsEnabled) return false;

    return account.payoutAccounts.some((a) =>
      (a.availablePayoutMethods ?? []).includes("instant"),
    );
  } catch {
    return false;
  }
};

export class PayoutSettingsService {
  public constructor(
    private readonly userRepository = new UserRepository(),
    private readonly stripeConnectService = new StripeConnectService(),
  ) {}

  public async getPayoutSettings(user: AuthUser): Promise<PayoutSettingsView> {
    if (user.accountType !== "business") {
      throw new AppError(BUSINESS_ONLY_ERROR, httpStatus.FORBIDDEN);
    }

    const [dbUser, instantPayoutEligible] = await Promise.all([
      this.userRepository.findById(user.id),
      resolveInstantEligible(user.id, this.stripeConnectService),
    ]);

    return {
      payoutPreference: dbUser?.businessProfile?.payoutPreference ?? "manual",
      withdrawalMethod: dbUser?.businessProfile?.withdrawalMethod ?? "bank_transfer",
      instantPayoutEligible,
    };
  }

  public async updatePayoutSettings(
    user: AuthUser,
    dto: UpdatePayoutSettingsDto,
  ): Promise<PayoutSettingsView> {
    if (user.accountType !== "business") {
      throw new AppError(BUSINESS_ONLY_ERROR, httpStatus.FORBIDDEN);
    }

    const [dbUser, instantPayoutEligible] = await Promise.all([
      this.userRepository.findById(user.id),
      dto.withdrawalMethod === "instant_debit_card"
        ? resolveInstantEligible(user.id, this.stripeConnectService)
        : Promise.resolve(true),
    ]);

    if (dto.withdrawalMethod === "instant_debit_card" && !instantPayoutEligible) {
      throw new AppError(
        "Instant payout is not available for your account",
        httpStatus.BAD_REQUEST,
        { code: "INSTANT_PAYOUT_NOT_ELIGIBLE" },
      );
    }

    const currentProfile = dbUser?.businessProfile ?? {
      payoutPreference: "manual" as const,
      withdrawalMethod: "bank_transfer" as const,
    };
    const updatedProfile: IBusinessProfileSettings = {
      payoutPreference: dto.payoutPreference ?? currentProfile.payoutPreference,
      withdrawalMethod: dto.withdrawalMethod ?? currentProfile.withdrawalMethod,
    };

    await this.userRepository.updateById(user.id, { businessProfile: updatedProfile });

    const finalInstantEligible = dto.withdrawalMethod === "instant_debit_card"
      ? instantPayoutEligible
      : await resolveInstantEligible(user.id, this.stripeConnectService);

    return {
      payoutPreference: updatedProfile.payoutPreference,
      withdrawalMethod: updatedProfile.withdrawalMethod,
      instantPayoutEligible: finalInstantEligible,
    };
  }
}
