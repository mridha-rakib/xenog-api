import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { AuthService } from "./auth.service.js";

export class AuthController {
  public constructor(private readonly authService = new AuthService()) {}

  public register = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.register(req.body);

    ApiResponse.success(res, {
      message: "Verification code sent. Please verify your email.",
      data: result,
    });
  };

  public login = async (req: Request, res: Response): Promise<void> => {
    const session = await this.authService.login(req.body);

    ApiResponse.success(res, {
      message: "Signed in successfully",
      data: session,
    });
  };

  public adminLogin = async (req: Request, res: Response): Promise<void> => {
    const session = await this.authService.login(req.body, "admin");

    ApiResponse.success(res, {
      message: "Signed in successfully",
      data: session,
    });
  };

  public verifyEmail = async (req: Request, res: Response): Promise<void> => {
    const session = await this.authService.verifyEmail(req.body);

    ApiResponse.success(res, {
      message: "Email verified successfully",
      data: session,
    });
  };

  public refresh = async (req: Request, res: Response): Promise<void> => {
    const session = await this.authService.refreshSession(req.body);

    ApiResponse.success(res, {
      message: "Session refreshed successfully",
      data: session,
    });
  };

  public changePassword = async (req: Request, res: Response): Promise<void> => {
    const userId = req.authUser?.id;

    if (!userId) {
      throw new Error("Authenticated user missing from request");
    }

    await this.authService.changePassword(userId, req.body);

    ApiResponse.success(res, {
      message: "Password updated successfully",
    });
  };

  public resendVerificationCode = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.resendVerificationCode(req.body);

    ApiResponse.success(res, {
      message: result.verificationRequired ? "Verification code sent" : "Email is already verified",
      data: result,
    });
  };

  public requestPasswordReset = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.requestPasswordReset(req.body);

    ApiResponse.success(res, {
      message: "If an account exists for this email, a password reset code has been sent.",
      data: result,
    });
  };

  public validatePasswordResetCode = async (req: Request, res: Response): Promise<void> => {
    await this.authService.validatePasswordResetCode(req.body);

    ApiResponse.success(res, {
      message: "Reset code verified",
    });
  };

  public resetPassword = async (req: Request, res: Response): Promise<void> => {
    await this.authService.resetPassword(req.body);

    ApiResponse.success(res, {
      message: "Password reset successfully",
    });
  };

  public me = async (req: Request, res: Response): Promise<void> => {
    ApiResponse.success(res, {
      message: "Current user retrieved",
      data: {
        user: req.authUser,
      },
    });
  };

  public updateMe = async (req: Request, res: Response): Promise<void> => {
    const userId = req.authUser?.id;

    if (!userId) {
      throw new Error("Authenticated user missing from request");
    }

    const user = await this.authService.updateCurrentUser(userId, req.body);

    ApiResponse.success(res, {
      message: "Profile updated",
      data: {
        user,
      },
    });
  };

  public deleteMe = async (req: Request, res: Response): Promise<void> => {
    const userId = req.authUser?.id;

    if (!userId) {
      throw new Error("Authenticated user missing from request");
    }

    await this.authService.deleteCurrentUser(userId);

    ApiResponse.success(res, {
      message: "Account deleted successfully",
    });
  };

  public logout = async (_req: Request, res: Response): Promise<void> => {
    ApiResponse.success(res, {
      message: "Signed out successfully",
    });
  };
}
