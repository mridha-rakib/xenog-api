export interface LoginDto {
  email: string;
  password: string;
}

export interface RegisterDto {
  name: string;
  username: string;
  email: string;
  password: string;
  accountType: "personal" | "business";
}

export interface VerifyEmailDto {
  email: string;
  code: string;
}

export interface ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}

export interface RefreshTokenDto {
  refreshToken: string;
}

export interface ResendVerificationDto {
  email: string;
}

export interface RequestPasswordResetDto {
  email: string;
}

export interface ValidatePasswordResetCodeDto {
  email: string;
  code: string;
}

export interface ResetPasswordDto {
  email: string;
  code: string;
  newPassword: string;
}

export interface AuthUser {
  id: string;
  name: string;
  username?: string;
  email: string;
  contact?: string | null;
  passwordChangedAt?: Date | null;
  accountType: "personal" | "business";
  avatarKey?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  currentLocationSharingEnabled: boolean;
  currentLocation?: AuthUserCurrentLocation | null;
  notificationsEnabled: boolean;
  role: "user" | "admin";
  isActive: boolean;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUserCurrentLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  updatedAt?: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
}

export interface AuthSession {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface RegistrationResult {
  email: string;
  verificationRequired: boolean;
}

export interface PasswordResetRequestResult {
  email: string;
}

export interface UpdateProfileDto {
  name?: string;
  username?: string;
  email?: string;
  contact?: string | null;
  accountType?: "personal" | "business";
  avatarKey?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  currentLocationSharingEnabled?: boolean;
  currentLocation?: AuthUserCurrentLocation | null;
  notificationsEnabled?: boolean;
}
