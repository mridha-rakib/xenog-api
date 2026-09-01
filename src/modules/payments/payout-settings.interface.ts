import type { PayoutPreference, WithdrawalMethod } from "../user/user.interface.js";
import type { EligibleInstantDebitCardView, InstantPayoutUnavailableReason } from "./stripe-connect.interface.js";

export interface PayoutSettingsView {
  payoutPreference: PayoutPreference;
  withdrawalMethod: WithdrawalMethod;
  instantPayoutEligible: boolean;
  eligibleInstantDebitCard: EligibleInstantDebitCardView | null;
  instantPayoutUnavailableReason: InstantPayoutUnavailableReason | null;
}

export interface UpdatePayoutSettingsDto {
  payoutPreference?: PayoutPreference;
  withdrawalMethod?: WithdrawalMethod;
}
