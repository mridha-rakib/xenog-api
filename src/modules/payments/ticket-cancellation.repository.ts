import { Types, type FilterQuery, type PipelineStage, type UpdateQuery } from "mongoose";
import { TicketCancellationModel } from "./ticket-cancellation.model.js";
import type {
  ITicketCancellation,
  ListAdminTicketCancellationsQuery,
  TicketCancellationRefundStatus,
  TicketCancellationStepStatus,
} from "./ticket-cancellation.interface.js";
import type { CancellationAuditEntry } from "./event-cancellation-refund.interface.js";

type CreateTicketCancellationPayload = Omit<
  ITicketCancellation,
  "_id" | "createdAt" | "updatedAt"
>;

export type ListTicketCancellationsResult = {
  cancellations: ITicketCancellation[];
  total: number;
};

export type TicketPassIdentity = {
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
};

const escapeSearchRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toObjectId = (value: string): Types.ObjectId => new Types.ObjectId(value);

export const ADMIN_TICKET_CANCELLATION_SORT = { createdAt: -1, _id: -1 } as const;

export const buildAdminTicketCancellationFilter = (
  query: ListAdminTicketCancellationsQuery,
): FilterQuery<ITicketCancellation> => {
  const filter: FilterQuery<ITicketCancellation> = {};

  if (query.sourceType) filter.sourceType = query.sourceType;
  if (query.status) filter.status = query.status;
  if (query.refundStatus) filter.refundStatus = query.refundStatus;
  if (query.eventId) filter.eventId = toObjectId(query.eventId);
  if (query.buyerUserId) filter.buyerUserId = toObjectId(query.buyerUserId);
  if (query.orderId) filter.orderId = toObjectId(query.orderId);
  if (query.ticketId) filter.ticketId = query.ticketId;
  if (query.ticketIndex) filter.ticketIndex = query.ticketIndex;
  if (query.ticketType) filter.ticketType = query.ticketType;

  if (query.monetary === "non_monetary") {
    filter.requestedAmountMinor = 0;
  } else if (query.monetary !== "all") {
    filter.requestedAmountMinor = { $gt: 0 };
  }

  return filter;
};

export const buildAdminTicketCancellationSearchPipeline = (
  query: ListAdminTicketCancellationsQuery,
): PipelineStage[] => {
  const filter = buildAdminTicketCancellationFilter(query);
  const normalizedSearch = query.search?.trim();

  if (!normalizedSearch) {
    return [{ $match: filter }];
  }

  const escapedSearch = escapeSearchRegex(normalizedSearch);

  return [
    { $match: filter },
    {
      $lookup: {
        from: "users",
        localField: "buyerUserId",
        foreignField: "_id",
        as: "buyerSearchUser",
      },
    },
    {
      $addFields: {
        buyerSearchUser: { $first: "$buyerSearchUser" },
        eventIdSearch: { $toString: "$eventId" },
        orderIdSearch: { $toString: "$orderId" },
        ticketIndexSearch: { $toString: "$ticketIndex" },
        ticketTypeSearch: {
          $ifNull: [
            "$ticketType",
            { $cond: [{ $gt: ["$requestedAmountMinor", 0] }, "paid", "free"] },
          ],
        },
      },
    },
    {
      $addFields: {
        passIdentitySearch: {
          $concat: [
            { $ifNull: ["$ticketId", ""] },
            " ",
            "$ticketIndexSearch",
            " ",
            "$orderIdSearch",
          ],
        },
      },
    },
    {
      $match: {
        $or: [
          { ticketId: { $regex: escapedSearch, $options: "i" } },
          { ticketName: { $regex: escapedSearch, $options: "i" } },
          { ticketTypeSearch: { $regex: escapedSearch, $options: "i" } },
          { eventName: { $regex: escapedSearch, $options: "i" } },
          { eventIdSearch: { $regex: escapedSearch, $options: "i" } },
          { orderIdSearch: { $regex: escapedSearch, $options: "i" } },
          { ticketIndexSearch: { $regex: escapedSearch, $options: "i" } },
          { passIdentitySearch: { $regex: escapedSearch, $options: "i" } },
          { providerStatus: { $regex: escapedSearch, $options: "i" } },
          { "buyerSearchUser.name": { $regex: escapedSearch, $options: "i" } },
          { "buyerSearchUser.email": { $regex: escapedSearch, $options: "i" } },
          { "buyerSearchUser.username": { $regex: escapedSearch, $options: "i" } },
        ],
      },
    },
    { $project: { buyerSearchUser: 0, eventIdSearch: 0, orderIdSearch: 0, ticketIndexSearch: 0, ticketTypeSearch: 0, passIdentitySearch: 0 } },
  ];
};

const audit = (
  action: CancellationAuditEntry["action"],
  actorUserId?: string | null,
  message?: string | null,
  metadata?: Record<string, unknown> | null,
): CancellationAuditEntry => ({
  action,
  actorUserId: actorUserId ? (actorUserId as never) : null,
  message: message ?? null,
  metadata: metadata ?? null,
  createdAt: new Date(),
});

export class TicketCancellationRepository {
  public async createOrGet(payload: CreateTicketCancellationPayload): Promise<{
    cancellation: ITicketCancellation;
    created: boolean;
  }> {
    try {
      const cancellation = await TicketCancellationModel.create(payload);
      return { cancellation, created: true };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }

      const existing = await this.findByPass({
        eventId: payload.eventId.toString(),
        ticketId: payload.ticketId,
        orderId: payload.orderId.toString(),
        ticketIndex: payload.ticketIndex,
      });
      if (!existing) {
        throw error;
      }

      return { cancellation: existing, created: false };
    }
  }

  public async findByPass(identity: TicketPassIdentity): Promise<ITicketCancellation | null> {
    return TicketCancellationModel.findOne({
      eventId: identity.eventId,
      ticketId: identity.ticketId,
      orderId: identity.orderId,
      ticketIndex: identity.ticketIndex,
    });
  }

  public async existsByPass(identity: TicketPassIdentity): Promise<boolean> {
    return Boolean(await TicketCancellationModel.exists({
      eventId: identity.eventId,
      ticketId: identity.ticketId,
      orderId: identity.orderId,
      ticketIndex: identity.ticketIndex,
    }));
  }

  public async findById(id: string): Promise<ITicketCancellation | null> {
    return TicketCancellationModel.findById(id);
  }

  public async findByStripeRefundId(stripeRefundId: string): Promise<ITicketCancellation | null> {
    return TicketCancellationModel.findOne({ stripeRefundId });
  }

  public async findByOrderId(orderId: string): Promise<ITicketCancellation[]> {
    return TicketCancellationModel.find({ orderId }).sort({ ticketIndex: 1, _id: 1 });
  }

  public async findByOrderIds(orderIds: string[]): Promise<ITicketCancellation[]> {
    return orderIds.length > 0
      ? TicketCancellationModel.find({ orderId: { $in: orderIds } }).sort({ createdAt: -1, _id: -1 })
      : [];
  }

  public async findByEventId(eventId: string): Promise<ITicketCancellation[]> {
    return TicketCancellationModel.find({ eventId }).sort({ createdAt: -1, _id: -1 });
  }

  public async findByEventIds(eventIds: string[]): Promise<ITicketCancellation[]> {
    return eventIds.length > 0
      ? TicketCancellationModel.find({ eventId: { $in: eventIds } }).sort({ createdAt: -1, _id: -1 })
      : [];
  }

  public async findByPaymentIntentId(paymentIntentId: string): Promise<ITicketCancellation[]> {
    return TicketCancellationModel.find({ stripePaymentIntentId: paymentIntentId }).sort({ createdAt: -1, _id: -1 });
  }

  public async sumRequestedAmountByOrderId(orderId: string): Promise<number> {
    const rows = await TicketCancellationModel.find({ orderId }).select("requestedAmountMinor").lean();
    return rows.reduce((sum, row) => sum + (row.requestedAmountMinor ?? 0), 0);
  }

  public async countByBuyerEventTicket(
    buyerUserId: string,
    eventId: string,
    ticketId: string,
  ): Promise<number> {
    return TicketCancellationModel.countDocuments({ buyerUserId, eventId, ticketId });
  }

  public async countByEventTicket(eventId: string, ticketId: string): Promise<number> {
    return TicketCancellationModel.countDocuments({ eventId, ticketId });
  }

  public async countByOrderEventTicket(orderId: string, eventId: string, ticketId: string): Promise<number> {
    return TicketCancellationModel.countDocuments({ orderId, eventId, ticketId });
  }

  public async update(
    cancellationId: string,
    update: UpdateQuery<ITicketCancellation>,
  ): Promise<ITicketCancellation | null> {
    return TicketCancellationModel.findByIdAndUpdate(cancellationId, update, { new: true, runValidators: true });
  }

  public async markStepCompleted(
    cancellationId: string,
    field: "capacityReleaseStatus" | "shareRevocationStatus" | "qrInvalidationStatus",
    actorUserId?: string | null,
    message?: string | null,
  ): Promise<ITicketCancellation | null> {
    return this.update(cancellationId, {
      $set: { [field]: "completed" satisfies TicketCancellationStepStatus },
      $push: { auditHistory: audit("passes_invalidated", actorUserId ?? null, message ?? `${field} completed`) },
    });
  }

  public async claimNextRefund(workerId: string, lockMs: number): Promise<ITicketCancellation | null> {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockMs);
    const query: FilterQuery<ITicketCancellation> = {
      requestedAmountMinor: { $gt: 0 },
      $or: [
        { refundStatus: { $in: ["pending", "failed_retryable"] }, $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
        { refundStatus: "processing", lockExpiresAt: { $lte: now } },
      ],
    };

    return TicketCancellationModel.findOneAndUpdate(
      query,
      {
        $set: {
          refundStatus: "processing",
          lockedBy: workerId,
          lockedAt: now,
          lockExpiresAt,
        },
        $inc: { attemptCount: 1 },
        $push: { auditHistory: audit("refund_claimed", null, "Ticket cancellation refund claimed", { workerId }) },
      },
      { new: true, sort: { nextRetryAt: 1, createdAt: 1, _id: 1 } },
    );
  }

  public async findNonFinalRefunds(limit = 50): Promise<ITicketCancellation[]> {
    return TicketCancellationModel.find({
      requestedAmountMinor: { $gt: 0 },
      refundStatus: { $in: ["pending", "processing", "failed_retryable", "reconciliation_required"] },
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit);
  }

  public async listAdmin(
    query: ListAdminTicketCancellationsQuery,
    skip: number,
    limit: number,
  ): Promise<ListTicketCancellationsResult> {
    const normalizedSearch = query.search?.trim();
    if (normalizedSearch) {
      const [result] = await TicketCancellationModel.aggregate<{
        cancellations: ITicketCancellation[];
        total: Array<{ count: number }>;
      }>([
        ...buildAdminTicketCancellationSearchPipeline(query),
        { $sort: ADMIN_TICKET_CANCELLATION_SORT },
        {
          $facet: {
            cancellations: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ]);

      return {
        cancellations: result?.cancellations ?? [],
        total: result?.total[0]?.count ?? 0,
      };
    }

    const filter = buildAdminTicketCancellationFilter(query);

    const [cancellations, total] = await Promise.all([
      TicketCancellationModel.find(filter).sort(ADMIN_TICKET_CANCELLATION_SORT).skip(skip).limit(limit),
      TicketCancellationModel.countDocuments(filter),
    ]);

    return { cancellations, total };
  }

  public async listMonetary(limit = 100): Promise<ITicketCancellation[]> {
    return TicketCancellationModel.find({ requestedAmountMinor: { $gt: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
  }

  public async retry(
    cancellationId: string,
    actorUserId: string,
  ): Promise<ITicketCancellation | null> {
    return this.update(cancellationId, {
      $set: {
        refundStatus: "pending" satisfies TicketCancellationRefundStatus,
        nextRetryAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastErrorCode: null,
        safeLastErrorMessage: null,
      },
      $push: { auditHistory: audit("admin_retry", actorUserId, "Admin retry requested") },
    });
  }
}
