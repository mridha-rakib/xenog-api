import Stripe from "stripe";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import type { IEvent } from "../events/event.interface.js";
import type { CheckoutOrderLineItem, CheckoutTaxSnapshot } from "./checkout-payment.interface.js";

type StripeClient = InstanceType<typeof Stripe>;

export interface CheckoutTaxInput {
  currency: string;
  lineItems: CheckoutOrderLineItem[];
  platformFeeAmount: number;
  event?: IEvent | null;
}

const roundCurrency = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const toMinorAmount = (value: number): number => Math.round(roundCurrency(value) * 100);
const fromMinorAmount = (value: number): number => roundCurrency(value / 100);

export class CheckoutTaxService {
  public constructor(private readonly stripeFactory: () => StripeClient) {}

  public async calculate(input: CheckoutTaxInput): Promise<CheckoutTaxSnapshot> {
    const venueSnapshot = this.getVenueSnapshot(input.event ?? null);
    const taxableAmount = roundCurrency(
      input.lineItems.reduce((sum, item) => sum + item.totalAmount, 0) + input.platformFeeAmount,
    );

    if (taxableAmount <= 0) {
      return this.zero("not_applicable", "none", venueSnapshot, "No taxable checkout amount.");
    }

    if (!env.STRIPE_TAX_ENABLED) {
      return this.zero(
        "configuration_unavailable_zero_fallback",
        "none",
        venueSnapshot,
        "Stripe Tax is disabled.",
        "STRIPE_TAX_DISABLED",
      );
    }

    const address = this.getStripeAddress(venueSnapshot);
    if (!address) {
      return this.zero(
        "configuration_unavailable_zero_fallback",
        "stripe_tax",
        venueSnapshot,
        "Venue address is insufficient for tax calculation.",
        "VENUE_ADDRESS_INSUFFICIENT",
      );
    }

    try {
      const stripe = this.stripeFactory();
      const taxApi = (stripe.tax as unknown as { calculations?: { create?: (payload: unknown) => Promise<unknown> } }).calculations;

      if (!taxApi?.create) {
        return this.zero(
          "configuration_unavailable_zero_fallback",
          "stripe_tax",
          venueSnapshot,
          "Stripe Tax calculations API is not available in the configured SDK.",
          "STRIPE_TAX_API_UNAVAILABLE",
        );
      }

      const calculation = await Promise.race([
        taxApi.create({
          currency: input.currency,
          line_items: [
            ...input.lineItems
              .filter((item) => item.totalAmount > 0)
              .map((item, index) => ({
                amount: toMinorAmount(item.totalAmount),
                reference: `${item.itemType}:${item.itemId ?? index}`,
              })),
            ...(input.platformFeeAmount > 0
              ? [{ amount: toMinorAmount(input.platformFeeAmount), reference: "platform_fee" }]
              : []),
          ],
          customer_details: {
            address,
            address_source: "shipping",
          },
          expand: ["line_items"],
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Stripe Tax calculation timed out")), env.STRIPE_TAX_TIMEOUT_MS);
        }),
      ]) as {
        id?: string;
        tax_amount_exclusive?: number;
        amount_tax?: number;
        tax_breakdown?: Array<{ jurisdiction?: { display_name?: string | null } | null }>;
      };

      const taxMinor = calculation.tax_amount_exclusive ?? calculation.amount_tax ?? 0;
      const amount = fromMinorAmount(taxMinor);
      const jurisdictionSummary = calculation.tax_breakdown
        ?.map((item) => item.jurisdiction?.display_name)
        .filter((value): value is string => Boolean(value))
        .join(", ") || null;

      return {
        amount,
        status: amount > 0 ? "calculated_non_zero" : "calculated_zero",
        provider: "stripe_tax",
        calculationId: calculation.id ?? null,
        transactionId: null,
        failureCode: null,
        failureReason: null,
        venueSnapshot,
        jurisdictionSummary,
        calculatedAt: new Date(),
      };
    } catch (error) {
      logger.warn({ error }, "Stripe Tax failed; continuing checkout with zero tax");
      return this.zero(
        "provider_failure_zero_fallback",
        "stripe_tax",
        venueSnapshot,
        error instanceof Error ? error.message : "Stripe Tax calculation failed.",
        this.getErrorCode(error),
      );
    }
  }

  private zero(
    status: CheckoutTaxSnapshot["status"],
    provider: CheckoutTaxSnapshot["provider"],
    venueSnapshot: CheckoutTaxSnapshot["venueSnapshot"],
    failureReason?: string | null,
    failureCode?: string | null,
  ): CheckoutTaxSnapshot {
    return {
      amount: 0,
      status,
      provider,
      calculationId: null,
      transactionId: null,
      failureCode: failureCode ?? null,
      failureReason: failureReason ?? null,
      venueSnapshot,
      jurisdictionSummary: null,
      calculatedAt: new Date(),
    };
  }

  private getVenueSnapshot(event: IEvent | null): CheckoutTaxSnapshot["venueSnapshot"] {
    if (!event?.location) return null;

    return {
      searchLabel: event.location.searchLabel ?? null,
      venue: event.location.venue ?? null,
      address: event.location.address ?? null,
      formattedAddress: event.location.formattedAddress ?? null,
      addressLine1: event.location.addressLine1 ?? null,
      neighborhood: event.location.neighborhood ?? null,
      district: event.location.district ?? null,
      city: event.location.city ?? null,
      region: event.location.region ?? null,
      regionCode: event.location.regionCode ?? null,
      postalCode: event.location.postalCode ?? null,
      country: event.location.country ?? null,
      countryCode: event.location.countryCode ?? null,
      latitude: event.location.latitude ?? null,
      longitude: event.location.longitude ?? null,
      mapboxPlaceId: event.location.mapboxPlaceId ?? null,
      locationProvider: event.location.locationProvider ?? null,
      providerResultType: event.location.providerResultType ?? null,
    };
  }

  private getStripeAddress(venueSnapshot: CheckoutTaxSnapshot["venueSnapshot"]) {
    const line1 =
      venueSnapshot?.addressLine1?.trim() ||
      venueSnapshot?.address?.trim() ||
      venueSnapshot?.formattedAddress?.trim() ||
      venueSnapshot?.searchLabel?.trim();
    const country = venueSnapshot?.countryCode?.trim().toUpperCase();

    if (!line1 || !country) return null;

    return {
      line1,
      city: venueSnapshot?.city?.trim() || undefined,
      state: venueSnapshot?.regionCode?.trim() || venueSnapshot?.region?.trim() || undefined,
      postal_code: venueSnapshot?.postalCode?.trim() || undefined,
      country,
    };
  }

  private getErrorCode(error: unknown): string {
    if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return "STRIPE_TAX_ERROR";
  }
}
