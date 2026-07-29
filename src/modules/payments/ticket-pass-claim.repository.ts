import { TicketPassClaimModel, type ITicketPassClaim, type TicketPassClaimOwnerType } from "./ticket-pass-claim.model.js";
import type { TicketPassIdentity } from "./ticket-cancellation.repository.js";

export type TicketPassClaimResult =
  | { claimed: true; claim: ITicketPassClaim }
  | { claimed: false; reason: "cancelled" | "used" | "busy" };

const PENDING_CLAIM_TTL_MS = 2 * 60 * 1000;

const identityFilter = (identity: TicketPassIdentity) => ({
  eventId: identity.eventId,
  ticketId: identity.ticketId,
  orderId: identity.orderId,
  ticketIndex: identity.ticketIndex,
});

const conflictReason = (claim: ITicketPassClaim): "cancelled" | "used" | "busy" => {
  if (claim.ownerType === "check_in") return "used";
  if (claim.status === "accepted") return "cancelled";
  return "busy";
};

export class TicketPassClaimRepository {
  public async claimForCancellation(identity: TicketPassIdentity): Promise<TicketPassClaimResult> {
    return this.claim(identity, "cancellation", new Date(Date.now() + PENDING_CLAIM_TTL_MS));
  }

  public async claimForCheckIn(identity: TicketPassIdentity): Promise<TicketPassClaimResult> {
    return this.claim(identity, "check_in", null, "accepted");
  }

  public async acceptCancellation(identity: TicketPassIdentity, cancellationId: string): Promise<boolean> {
    const updated = await TicketPassClaimModel.findOneAndUpdate(
      {
        ...identityFilter(identity),
        ownerType: "cancellation",
        status: "pending",
      },
      {
        $set: {
          status: "accepted",
          ownerId: cancellationId,
          expiresAt: null,
        },
      },
      { new: true },
    );

    return Boolean(updated);
  }

  public async abortCancellation(identity: TicketPassIdentity): Promise<void> {
    await TicketPassClaimModel.findOneAndUpdate(
      {
        ...identityFilter(identity),
        ownerType: "cancellation",
        status: "pending",
      },
      {
        $set: {
          status: "aborted",
          expiresAt: null,
        },
      },
    );
  }

  public async abortCheckIn(identity: TicketPassIdentity): Promise<void> {
    await TicketPassClaimModel.findOneAndUpdate(
      {
        ...identityFilter(identity),
        ownerType: "check_in",
        status: "accepted",
      },
      {
        $set: {
          status: "aborted",
          expiresAt: null,
        },
      },
    );
  }

  private async claim(
    identity: TicketPassIdentity,
    ownerType: TicketPassClaimOwnerType,
    expiresAt: Date | null,
    status: ITicketPassClaim["status"] = "pending",
  ): Promise<TicketPassClaimResult> {
    const now = new Date();
    const payload = {
      ...identityFilter(identity),
      ownerType,
      ownerId: null,
      status,
      claimedAt: now,
      expiresAt,
    };

    try {
      const claim = await TicketPassClaimModel.create(payload);
      return { claimed: true, claim };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
    }

    const existing = await TicketPassClaimModel.findOne(identityFilter(identity));
    if (!existing) {
      const claim = await TicketPassClaimModel.create(payload);
      return { claimed: true, claim };
    }

    const canTakeOver = existing.status === "aborted"
      || (existing.status === "pending" && Boolean(existing.expiresAt) && existing.expiresAt!.getTime() <= now.getTime());

    if (!canTakeOver) {
      return { claimed: false, reason: conflictReason(existing) };
    }

    const updated = await TicketPassClaimModel.findOneAndUpdate(
      {
        _id: existing._id,
        $or: [
          { status: "aborted" },
          { status: "pending", expiresAt: { $lte: now } },
        ],
      },
      { $set: payload },
      { new: true },
    );

    if (!updated) {
      const current = await TicketPassClaimModel.findOne(identityFilter(identity));
      return { claimed: false, reason: current ? conflictReason(current) : "busy" };
    }

    return { claimed: true, claim: updated };
  }
}
