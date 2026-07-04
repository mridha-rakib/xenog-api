import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import httpStatus from "http-status";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../../config/env.js";
import { EmailService } from "../../core/email/email.service.js";
import { AppError } from "../../core/errors/app-error.js";
import { UserRepository } from "../user/user.repository.js";
import type { IUser } from "../user/user.interface.js";
import type {
  AuthSession,
  AuthUser,
  ChangePasswordDto,
  LoginDto,
  PasswordResetRequestResult,
  RefreshTokenDto,
  RegisterDto,
  RegistrationResult,
  RequestPasswordResetDto,
  ResetPasswordDto,
  ResendVerificationDto,
  UpdateProfileDto,
  ValidatePasswordResetCodeDto,
  VerifyEmailDto,
} from "./auth.interface.js";

interface AccessTokenPayload {
  sub: string;
  email: string;
  role: AuthUser["role"];
  tokenUse?: "access" | "refresh";
}

interface RefreshTokenPayload {
  sub: string;
  email: string;
  role: AuthUser["role"];
  tokenUse: "refresh";
}

const toAuthUser = (user: IUser): AuthUser => ({
  id: user._id.toString(),
  name: user.name,
  username: user.username,
  email: user.email,
  contact: user.contact,
  passwordChangedAt: user.passwordChangedAt,
  accountType: user.accountType ?? "personal",
  avatarKey: user.avatarKey,
  gender: user.gender,
  age: user.age,
  bio: user.bio,
  address: user.address,
  businessDocumentKey: user.businessDocumentKey,
  currentLocationSharingEnabled: user.currentLocationSharingEnabled ?? false,
  currentLocation: user.currentLocation
    ? {
        latitude: user.currentLocation.latitude,
        longitude: user.currentLocation.longitude,
        accuracy: user.currentLocation.accuracy,
        updatedAt: user.currentLocation.updatedAt,
      }
    : null,
  notificationsEnabled: user.notificationsEnabled ?? true,
  role: user.role,
  isActive: user.isActive,
  emailVerified: user.emailVerified ?? true,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;

export class AuthService {
  public constructor(
    private readonly userRepository = new UserRepository(),
    private readonly emailService = new EmailService(),
  ) {}

  public async register(payload: RegisterDto): Promise<RegistrationResult> {
    const existingEmail = await this.userRepository.findByEmailWithVerification(payload.email);

    if (existingEmail) {
      if (existingEmail.emailVerified) {
        throw new AppError("Email already exists", httpStatus.CONFLICT);
      }

      if (existingEmail.username !== payload.username.toLowerCase()) {
        const existingUsername = await this.userRepository.findByUsername(payload.username);

        if (existingUsername && existingUsername._id.toString() !== existingEmail._id.toString()) {
          throw new AppError("Username already exists", httpStatus.CONFLICT);
        }
      }

      return this.issueVerificationCode(existingEmail);
    }

    await this.assertUniqueUsername(payload.username);

    const verificationCode = this.generateVerificationCode();
    const [passwordHash, emailVerificationCodeHash] = await Promise.all([
      bcrypt.hash(payload.password, 12),
      bcrypt.hash(verificationCode, 12),
    ]);

    const user = await this.userRepository.create({
      name: payload.name,
      username: payload.username.toLowerCase(),
      email: payload.email,
      accountType: payload.accountType,
      role: "user",
      passwordHash,
      emailVerified: false,
      emailVerificationCodeHash,
      emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
    });

    await this.emailService.sendVerificationCode({
      to: user.email,
      name: user.name,
      code: verificationCode,
    });

    return {
      email: user.email,
      verificationRequired: true,
    };
  }

  public async login(payload: LoginDto, requiredRole?: AuthUser["role"]): Promise<AuthSession> {
    const user = await this.userRepository.findByEmailOrUsernameWithPassword(payload.email);

    if (!user?.passwordHash) {
      throw new AppError("Invalid email/username or password", httpStatus.UNAUTHORIZED);
    }

    const passwordMatches = await bcrypt.compare(payload.password, user.passwordHash);

    if (!passwordMatches) {
      throw new AppError("Invalid email/username or password", httpStatus.UNAUTHORIZED);
    }

    if (!user.isActive) {
      throw new AppError("Your account is inactive", httpStatus.FORBIDDEN);
    }

    if (user.role === "user" && user.emailVerified === false) {
      throw new AppError("Please verify your email before signing in", httpStatus.FORBIDDEN, {
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    if (requiredRole && user.role !== requiredRole) {
      throw new AppError("You do not have permission to access this portal", httpStatus.FORBIDDEN);
    }

    const authUser = toAuthUser(user);

    return this.createSessionFromAuthUser(authUser);
  }

  public async verifyEmail(payload: VerifyEmailDto): Promise<AuthSession> {
    const user = await this.userRepository.findByEmailWithVerification(payload.email);

    if (!user) {
      throw new AppError("Account not found", httpStatus.NOT_FOUND);
    }

    if (user.emailVerified) {
      return this.createSession(user);
    }

    if (!user.emailVerificationCodeHash || !user.emailVerificationExpiresAt) {
      throw new AppError("Verification code is missing. Please request a new code.", httpStatus.BAD_REQUEST);
    }

    if (user.emailVerificationExpiresAt.getTime() < Date.now()) {
      throw new AppError("Verification code expired. Please request a new code.", httpStatus.BAD_REQUEST);
    }

    const codeMatches = await bcrypt.compare(payload.code, user.emailVerificationCodeHash);

    if (!codeMatches) {
      throw new AppError("Invalid verification code", httpStatus.BAD_REQUEST);
    }

    const verifiedUser = await this.userRepository.markEmailVerified(user._id.toString());

    if (!verifiedUser) {
      throw new AppError("Account not found", httpStatus.NOT_FOUND);
    }

    return this.createSession(verifiedUser);
  }

  public async refreshSession(payload: RefreshTokenDto): Promise<AuthSession> {
    const decoded = this.verifyRefreshToken(payload.refreshToken);
    const user = await this.getCurrentUser(decoded.sub);

    return this.createSessionFromAuthUser(user);
  }

  public async changePassword(userId: string, payload: ChangePasswordDto): Promise<void> {
    const user = await this.userRepository.findByIdWithPassword(userId);

    if (!user?.passwordHash) {
      throw new AppError("Password cannot be changed for this account", httpStatus.BAD_REQUEST);
    }

    const passwordMatches = await bcrypt.compare(payload.currentPassword, user.passwordHash);

    if (!passwordMatches) {
      throw new AppError("Current password is incorrect", httpStatus.BAD_REQUEST);
    }

    const passwordHash = await bcrypt.hash(payload.newPassword, 12);
    await this.userRepository.updatePasswordById(userId, passwordHash);
  }

  public async resendVerificationCode(payload: ResendVerificationDto): Promise<RegistrationResult> {
    const user = await this.userRepository.findByEmailWithVerification(payload.email);

    if (!user) {
      throw new AppError("Account not found", httpStatus.NOT_FOUND);
    }

    if (user.emailVerified) {
      return {
        email: user.email,
        verificationRequired: false,
      };
    }

    return this.issueVerificationCode(user);
  }

  public async requestPasswordReset(payload: RequestPasswordResetDto): Promise<PasswordResetRequestResult> {
    const normalizedEmail = payload.email.trim().toLowerCase();
    const user = await this.userRepository.findByEmailWithPasswordReset(normalizedEmail);

    if (!user?.passwordHash || !user.isActive) {
      return {
        email: normalizedEmail,
      };
    }

    const resetCode = this.generatePasswordResetCode();
    const passwordResetCodeHash = await bcrypt.hash(resetCode, 12);
    const updatedUser = await this.userRepository.updatePasswordResetById(user._id.toString(), {
      passwordResetCodeHash,
      passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS),
    });

    if (!updatedUser) {
      return {
        email: normalizedEmail,
      };
    }

    await this.emailService.sendPasswordResetCode({
      to: updatedUser.email,
      name: updatedUser.name,
      code: resetCode,
    });

    return {
      email: updatedUser.email,
    };
  }

  public async validatePasswordResetCode(payload: ValidatePasswordResetCodeDto): Promise<void> {
    await this.getValidPasswordResetUser(payload.email, payload.code);
  }

  public async resetPassword(payload: ResetPasswordDto): Promise<void> {
    const user = await this.getValidPasswordResetUser(payload.email, payload.code);

    if (!user.passwordResetCodeHash) {
      throw new AppError("Invalid or expired reset code", httpStatus.BAD_REQUEST);
    }

    const passwordHash = await bcrypt.hash(payload.newPassword, 12);
    const updatedUser = await this.userRepository.updatePasswordWithResetById(
      user._id.toString(),
      passwordHash,
      user.passwordResetCodeHash,
    );

    if (!updatedUser) {
      throw new AppError("Invalid or expired reset code", httpStatus.BAD_REQUEST);
    }
  }

  public async getCurrentUser(userId: string): Promise<AuthUser> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    if (!user.isActive) {
      throw new AppError("Your account is inactive", httpStatus.FORBIDDEN);
    }

    return toAuthUser(user);
  }

  public async updateCurrentUser(userId: string, payload: UpdateProfileDto): Promise<AuthUser> {
    if (payload.email) {
      const existingEmail = await this.userRepository.findByEmailExcludingId(payload.email, userId);

      if (existingEmail) {
        throw new AppError("Email already exists", httpStatus.CONFLICT);
      }
    }

    if (payload.username) {
      const existingUsername = await this.userRepository.findByUsernameExcludingId(payload.username, userId);

      if (existingUsername) {
        throw new AppError("Username already exists", httpStatus.CONFLICT);
      }
    }

    const updatePayload: UpdateProfileDto = {
      ...payload,
      ...(payload.email ? { email: payload.email.toLowerCase() } : {}),
      ...(payload.username ? { username: payload.username.toLowerCase() } : {}),
    };

    if (payload.currentLocationSharingEnabled === false) {
      updatePayload.currentLocation = null;
    } else if (payload.currentLocation) {
      updatePayload.currentLocation = {
        ...payload.currentLocation,
        updatedAt: new Date(),
      };
    }

    const user = await this.userRepository.updateById(userId, updatePayload);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return toAuthUser(user);
  }

  public async deleteCurrentUser(userId: string): Promise<void> {
    const user = await this.userRepository.deactivateAccountById(userId);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }
  }

  public verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;

      if (!decoded.sub || !decoded.email || !decoded.role || decoded.tokenUse === "refresh") {
        throw new AppError("Invalid access token", httpStatus.UNAUTHORIZED);
      }

      return decoded;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Session expired. Please sign in again.", httpStatus.UNAUTHORIZED);
    }
  }

  private signAccessToken(user: AuthUser): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenUse: "access",
    };
    const options: SignOptions = {
      expiresIn: (env.JWT_ACCESS_EXPIRES_IN ?? env.JWT_ACCESS_TTL_SECONDS) as SignOptions["expiresIn"],
    };

    return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
  }

  private verifyRefreshToken(token: string): RefreshTokenPayload {
    try {
      const decoded = jwt.verify(token, this.getRefreshTokenSecret()) as RefreshTokenPayload;

      if (!decoded.sub || !decoded.email || !decoded.role || decoded.tokenUse !== "refresh") {
        throw new AppError("Invalid refresh token", httpStatus.UNAUTHORIZED);
      }

      return decoded;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError("Session expired. Please sign in again.", httpStatus.UNAUTHORIZED);
    }
  }

  private signRefreshToken(user: AuthUser): string {
    const payload: RefreshTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenUse: "refresh",
    };
    const options: SignOptions = {
      expiresIn: env.JWT_REFRESH_TTL_SECONDS as SignOptions["expiresIn"],
    };

    return jwt.sign(payload, this.getRefreshTokenSecret(), options);
  }

  private getRefreshTokenSecret(): string {
    return env.JWT_REFRESH_SECRET ?? env.JWT_ACCESS_SECRET;
  }

  private createSession(user: IUser): AuthSession {
    const authUser = toAuthUser(user);

    return this.createSessionFromAuthUser(authUser);
  }

  private createSessionFromAuthUser(authUser: AuthUser): AuthSession {
    return {
      user: authUser,
      tokens: {
        accessToken: this.signAccessToken(authUser),
        refreshToken: this.signRefreshToken(authUser),
        tokenType: "Bearer",
      },
    };
  }

  private async assertUniqueUsername(username: string): Promise<void> {
    const existingUsername = await this.userRepository.findByUsername(username);

    if (existingUsername) {
      throw new AppError("Username already exists", httpStatus.CONFLICT);
    }
  }

  private generateVerificationCode(): string {
    return randomInt(1000, 10000).toString();
  }

  private generatePasswordResetCode(): string {
    return randomInt(1000, 10000).toString();
  }

  private async getValidPasswordResetUser(email: string, code: string): Promise<IUser> {
    const user = await this.userRepository.findByEmailWithPasswordReset(email);

    if (!user?.passwordHash || !user.passwordResetCodeHash || !user.passwordResetExpiresAt || !user.isActive) {
      throw new AppError("Invalid or expired reset code", httpStatus.BAD_REQUEST);
    }

    if (user.passwordResetExpiresAt.getTime() < Date.now()) {
      await this.userRepository.clearPasswordResetById(user._id.toString());
      throw new AppError("Invalid or expired reset code", httpStatus.BAD_REQUEST);
    }

    const codeMatches = await bcrypt.compare(code, user.passwordResetCodeHash);

    if (!codeMatches) {
      throw new AppError("Invalid or expired reset code", httpStatus.BAD_REQUEST);
    }

    return user;
  }

  private async issueVerificationCode(user: IUser): Promise<RegistrationResult> {
    const verificationCode = this.generateVerificationCode();
    const emailVerificationCodeHash = await bcrypt.hash(verificationCode, 12);

    const updatedUser = await this.userRepository.updateVerificationById(user._id.toString(), {
      emailVerificationCodeHash,
      emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
    });

    if (!updatedUser) {
      throw new AppError("Account not found", httpStatus.NOT_FOUND);
    }

    await this.emailService.sendVerificationCode({
      to: updatedUser.email,
      name: updatedUser.name,
      code: verificationCode,
    });

    return {
      email: updatedUser.email,
      verificationRequired: true,
    };
  }
}
