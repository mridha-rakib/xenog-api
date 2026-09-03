import { UserConsentModel } from "./user-consent.model.js";
import type { IUserConsent, RecordUserConsentDto } from "./user-consent.interface.js";

export class UserConsentRepository {
  public async record(payload: RecordUserConsentDto): Promise<IUserConsent> {
    return UserConsentModel.create(payload);
  }
}
