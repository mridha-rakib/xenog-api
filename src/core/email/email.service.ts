import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env.js";
import { logger } from "../logger/logger.js";

interface VerificationEmailPayload {
  to: string;
  name: string;
  code: string;
}

interface PasswordResetEmailPayload {
  to: string;
  name: string;
  code: string;
}

export class EmailService {
  private transporter: Transporter | null = null;

  public isConfigured(): boolean {
    return this.canSendEmail();
  }

  public async sendMail(payload: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    if (!this.canSendEmail()) {
      throw new Error("Email provider is not configured.");
    }

    await this.getTransporter().sendMail({
      from: env.EMAIL_FROM,
      ...payload,
    });
  }

  public async sendVerificationCode(payload: VerificationEmailPayload): Promise<void> {
    if (!this.canSendEmail()) {
      logger.warn(
        {
          email: payload.to,
          code: payload.code,
        },
        "Email provider not configured; verification code logged for development",
      );
      return;
    }

    await this.getTransporter().sendMail({
      from: env.EMAIL_FROM,
      to: payload.to,
      subject: "Verify your Xenog account",
      text: `Hi ${payload.name}, your Xenog verification code is ${payload.code}. It expires in 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h2>Verify your Xenog account</h2>
          <p>Hi ${payload.name},</p>
          <p>Your verification code is:</p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 8px;">${payload.code}</p>
          <p>This code expires in 10 minutes.</p>
        </div>
      `,
    });
  }

  public async sendPasswordResetCode(payload: PasswordResetEmailPayload): Promise<void> {
    if (!this.canSendEmail()) {
      logger.warn(
        {
          email: payload.to,
          code: payload.code,
        },
        "Email provider not configured; password reset code logged for development",
      );
      return;
    }

    await this.getTransporter().sendMail({
      from: env.EMAIL_FROM,
      to: payload.to,
      subject: "Reset your Xenog password",
      text: `Hi ${payload.name}, your Xenog 4-digit password reset code is ${payload.code}. It expires in 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <h2>Reset your Xenog password</h2>
          <p>Hi ${payload.name},</p>
          <p>Your 4-digit password reset code is:</p>
          <p style="font-size: 28px; font-weight: 700; letter-spacing: 8px;">${payload.code}</p>
          <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
        </div>
      `,
    });
  }

  private canSendEmail(): boolean {
    return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
  }

  private getTransporter(): Transporter {
    if (this.transporter) {
      return this.transporter;
    }

    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });

    return this.transporter;
  }
}
