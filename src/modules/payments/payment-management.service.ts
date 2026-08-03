import { StorageService } from "../storage/storage.service.js";
import { PaymentManagementRepository } from "./payment-management.repository.js";
import type { CapturedOrderFilter } from "./payment-management.repository.js";
import type { IUser } from "../user/user.interface.js";
import type {
  CapturedTicketOrderRow,
  PaymentManagementItemResponse,
  PaymentManagementListResponse,
  PaymentManagementQuery,
  PaymentManagementStatus,
  PaymentManagementUserResponse,
  RefundSummaryStatus,
} from "./payment-management.interface.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const UNKNOWN_USER: PaymentManagementUserResponse = {
  name: "Unknown user",
  email: null,
  avatarUrl: null,
  accountType: "personal",
};

export class PaymentManagementService {
  public constructor(
    private readonly repository = new PaymentManagementRepository(),
    private readonly storageService = new StorageService(),
  ) {}

  public async list(query: PaymentManagementQuery): Promise<PaymentManagementListResponse> {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const paidAtRange = this.resolveDateRange(query);
    const paymentStatusFilter = query.status ?? { $in: ["paid", "refunded"] as PaymentManagementStatus[] };

    const trimmedSearch = query.search?.trim();

    if (trimmedSearch) {
      const matchedUserIds = await this.repository.findMatchingUserIds(trimmedSearch);

      if (matchedUserIds.length === 0) {
        return {
          items: [],
          pagination: { page, limit, total: 0, totalPages: 0, from: 0, to: 0 },
        };
      }

      return this.buildPage(
        { paymentStatusFilter, paidAtRange, userIds: matchedUserIds },
        page,
        limit,
        skip,
      );
    }

    return this.buildPage({ paymentStatusFilter, paidAtRange }, page, limit, skip);
  }

  private async buildPage(
    filter: CapturedOrderFilter,
    page: number,
    limit: number,
    skip: number,
  ): Promise<PaymentManagementListResponse> {
    const [total, rows] = await Promise.all([
      this.repository.countCapturedTicketOrders(filter),
      this.repository.findCapturedTicketOrders(filter, skip, limit),
    ]);

    const orderIds = rows.map((row) => row.id);
    const userIds = rows.map((row) => row.userId);

    const [usersById, userRefundTotals, hostRefundTotals] = await Promise.all([
      this.repository.findUsersByIds(userIds),
      this.repository.getUserTicketRefundTotals(orderIds),
      this.repository.getHostEventRefundTotals(orderIds),
    ]);

    const avatarUrlByUserId = await this.resolveAvatarUrls(usersById);

    const items = rows.map((row) =>
      this.toItemResponse(row, usersById, avatarUrlByUserId, userRefundTotals, hostRefundTotals),
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        from: total === 0 ? 0 : (page - 1) * limit + 1,
        to: total === 0 ? 0 : Math.min(page * limit, total),
      },
    };
  }

  private async resolveAvatarUrls(usersById: Map<string, IUser>): Promise<Map<string, string | null>> {
    const entries = await Promise.all(
      [...usersById.values()].map(async (user): Promise<[string, string | null]> => {
        if (!user.avatarKey) {
          return [user._id.toString(), null];
        }

        try {
          const download = await this.storageService.createDownloadUrl(user.avatarKey);
          return [user._id.toString(), download.url];
        } catch {
          return [user._id.toString(), null];
        }
      }),
    );

    return new Map(entries);
  }

  private toItemResponse(
    row: CapturedTicketOrderRow,
    usersById: Map<string, IUser>,
    avatarUrlByUserId: Map<string, string | null>,
    userRefundTotals: Map<string, number>,
    hostRefundTotals: Map<string, number>,
  ): PaymentManagementItemResponse {
    const user = usersById.get(row.userId);
    const userResponse: PaymentManagementUserResponse = user
      ? {
          name: user.name || "Deleted User",
          email: user.email || null,
          avatarUrl: avatarUrlByUserId.get(row.userId) ?? null,
          accountType: user.accountType ?? "personal",
        }
      : UNKNOWN_USER;

    const successfulRefundedMinor =
      (userRefundTotals.get(row.id) ?? 0) + (hostRefundTotals.get(row.id) ?? 0);

    return {
      id: row.id,
      user: userResponse,
      paymentStatus: row.paymentStatus,
      paidAt: row.paidAt ? row.paidAt.toISOString() : "",
      amountMinor: row.amountMinor,
      currency: row.currency,
      refundSummary: {
        successfulRefundedMinor,
        status: this.resolveRefundStatus(successfulRefundedMinor, row.amountMinor),
      },
    };
  }

  private resolveRefundStatus(successfulRefundedMinor: number, amountMinor: number): RefundSummaryStatus {
    if (successfulRefundedMinor <= 0) return "none";
    if (successfulRefundedMinor >= amountMinor) return "full";
    return "partial";
  }

  private resolveDateRange(query: PaymentManagementQuery): { start: Date; end: Date } | undefined {
    if (!query.start || !query.end) {
      return undefined;
    }

    // payment-management.validation.ts already guarantees valid YYYY-MM-DD
    // dates, start <= end, and a max 365-day span.
    const start = startOfUtcDay(new Date(`${query.start}T00:00:00.000Z`));
    const endDay = startOfUtcDay(new Date(`${query.end}T00:00:00.000Z`));
    const end = new Date(endDay.getTime() + DAY_MS);

    return { start, end };
  }
}
