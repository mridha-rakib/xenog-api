import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { env } from "../../config/env.js";
import { StripeConnectService } from "./stripe-connect.service.js";

export class StripeConnectController {
  public constructor(private readonly service = new StripeConnectService()) {}

  public returnToApp = async (_req: Request, res: Response): Promise<void> => {
    res.type("html").send(this.createRedirectHtml(env.STRIPE_CONNECT_APP_RETURN_URL, "Stripe account connected"));
  };

  public refreshOnboarding = async (_req: Request, res: Response): Promise<void> => {
    res
      .type("html")
      .send(this.createRedirectHtml(env.STRIPE_CONNECT_APP_REFRESH_URL, "Stripe onboarding link expired"));
  };

  public getAccount = async (req: Request, res: Response): Promise<void> => {
    const userId = req.authUser?.id;

    if (!userId) {
      throw new Error("Authenticated user missing from request");
    }

    const account = await this.service.getAccount(userId);

    ApiResponse.success(res, {
      message: "Stripe Connect account retrieved",
      data: {
        account,
      },
    });
  };

  public createOnboardingLink = async (req: Request, res: Response): Promise<void> => {
    const user = req.authUser;

    if (!user) {
      throw new Error("Authenticated user missing from request");
    }

    const onboardingLink = await this.service.createOnboardingLink(user, req.body);

    ApiResponse.success(res, {
      message: "Stripe Connect onboarding link created",
      data: onboardingLink,
    });
  };

  private createRedirectHtml(appUrl: string | undefined, title: string): string {
    const escapedTitle = this.escapeHtml(title);
    const escapedAppUrl = appUrl ? this.escapeHtml(appUrl) : "";
    const redirectScript = appUrl ? `window.location.replace(${JSON.stringify(appUrl)});` : "";
    const fallbackLink = appUrl
      ? `<a href="${escapedAppUrl}" style="color:#635bff;font-weight:700;">Return to Mooment</a>`
      : "<p>You can close this page and return to Mooment.</p>";

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0e0d12;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(88vw, 420px);
        text-align: center;
      }
      p {
        color: #b8b8c6;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapedTitle}</h1>
      <p>Returning you to Mooment.</p>
      ${fallbackLink}
    </main>
    <script>${redirectScript}</script>
  </body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
