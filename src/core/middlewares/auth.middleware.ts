import type { RequestHandler } from "express";
import httpStatus from "http-status";
import { AppError } from "../errors/app-error.js";
import { AuthService } from "../../modules/auth/auth.service.js";
import type { AuthUser } from "../../modules/auth/auth.interface.js";

const authService = new AuthService();

const getBearerToken = (authorization?: string): string | null => {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
};

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = getBearerToken(req.headers.authorization);

    if (!token) {
      throw new AppError("Authentication required", httpStatus.UNAUTHORIZED);
    }

    const payload = authService.verifyAccessToken(token);
    req.authUser = await authService.getCurrentUser(payload.sub);

    next();
  } catch (error) {
    next(error);
  }
};

export const optionallyAuthenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = getBearerToken(req.headers.authorization);

    if (!token) {
      next();
      return;
    }

    const payload = authService.verifyAccessToken(token);
    req.authUser = await authService.getCurrentUser(payload.sub);

    next();
  } catch (error) {
    next(error);
  }
};

export const authorizeRoles =
  (...roles: AuthUser["role"][]): RequestHandler =>
  (req, _res, next) => {
    if (!req.authUser) {
      next(new AppError("Authentication required", httpStatus.UNAUTHORIZED));
      return;
    }

    if (!roles.includes(req.authUser.role)) {
      next(new AppError("You do not have permission to access this resource", httpStatus.FORBIDDEN));
      return;
    }

    next();
  };

export const requireBusinessAccount: RequestHandler = (req, _res, next) => {
  if (!req.authUser) {
    next(new AppError("Authentication required", httpStatus.UNAUTHORIZED));
    return;
  }

  if (req.authUser.accountType !== "business") {
    next(
      new AppError(
        "A Business Account is required to create and manage events",
        httpStatus.FORBIDDEN,
        { code: "BUSINESS_ACCOUNT_REQUIRED" },
      ),
    );
    return;
  }

  next();
};
