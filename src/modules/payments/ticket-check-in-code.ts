import { randomInt } from "node:crypto";
import type { CheckoutOrderLineItem, CheckoutOrderTicketPass } from "./checkout-payment.interface.js";

const CHECK_IN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const generateTicketCheckInCode = (createdAt = new Date()): string => {
  const year = String(createdAt.getUTCFullYear()).slice(-2);
  const segment = (): string => Array.from(
    { length: 4 },
    () => CHECK_IN_CODE_ALPHABET[randomInt(CHECK_IN_CODE_ALPHABET.length)] ?? "X",
  ).join("");

  return `MOM-${year}-${segment()}-${segment()}`;
};

export const createCheckoutTicketPasses = (
  lineItems: CheckoutOrderLineItem[],
  createdAt = new Date(),
): CheckoutOrderTicketPass[] => {
  const generatedCodes = new Set<string>();
  const ticketPasses: CheckoutOrderTicketPass[] = [];

  for (const lineItem of lineItems) {
    if (lineItem.itemType !== "ticket" || !lineItem.eventId || !lineItem.itemId) {
      continue;
    }

    const totalQuantity = lineItem.totalQuantity ?? lineItem.quantity;

    for (let ticketIndex = 1; ticketIndex <= totalQuantity; ticketIndex += 1) {
      let checkInCode = generateTicketCheckInCode(createdAt);

      while (generatedCodes.has(checkInCode)) {
        checkInCode = generateTicketCheckInCode(createdAt);
      }

      generatedCodes.add(checkInCode);
      ticketPasses.push({
        eventId: lineItem.eventId,
        ticketId: lineItem.itemId,
        ticketIndex,
        checkInCode,
      });
    }
  }

  return ticketPasses;
};
