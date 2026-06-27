import type { PayoutPreference, WithdrawalMethod } from "../user/user.interface.js";

export interface PayoutSettingsView {
  payoutPreference: PayoutPreference;
  withdrawalMethod: WithdrawalMethod;
  instantPayoutEligible: boolean;
}

export interface UpdatePayoutSettingsDto {
  payoutPreference?: PayoutPreference;
  withdrawalMethod?: WithdrawalMethod;
}
