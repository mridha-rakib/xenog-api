import type { AuthUser } from "../../modules/auth/auth.interface.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export {};
