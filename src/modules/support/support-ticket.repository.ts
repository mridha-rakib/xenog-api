import type { FilterQuery } from "mongoose";
import { SupportTicketModel } from "./support-ticket.model.js";
import type {
  CreateSupportTicketDto,
  CreateSupportTicketMessageDto,
  ISupportTicket,
  ListSupportTicketsQuery,
  SupportTicketModifier,
  SupportTicketStatus,
} from "./support-ticket.interface.js";

interface CreateSupportTicketRecord extends CreateSupportTicketDto {
  userId: string;
  requesterName: string;
  requesterEmail: string;
  requesterAvatarKey?: string | null;
  now: Date;
}

interface AppendMessageRecord extends CreateSupportTicketMessageDto {
  senderId: string;
  senderName: string;
  modifiedBy: SupportTicketModifier;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class SupportTicketRepository {
  public async create(payload: CreateSupportTicketRecord): Promise<ISupportTicket> {
    return SupportTicketModel.create({
      userId: payload.userId,
      requesterName: payload.requesterName,
      requesterEmail: payload.requesterEmail,
      requesterAvatarKey: payload.requesterAvatarKey ?? null,
      title: payload.title,
      description: payload.description,
      status: "pending",
      lastMessageAt: payload.now,
      messages: [
        {
          senderType: "user",
          senderId: payload.userId,
          senderName: payload.requesterName,
          title: payload.title,
          body: payload.description,
          createdAt: payload.now,
        },
      ],
    });
  }

  public async findById(id: string): Promise<ISupportTicket | null> {
    return SupportTicketModel.findById(id);
  }

  public async findMany(query: ListSupportTicketsQuery): Promise<{ tickets: ISupportTicket[]; total: number }> {
    const filter = this.buildFilter(query);
    const skip = (query.page - 1) * query.limit;

    const [tickets, total] = await Promise.all([
      SupportTicketModel.find(filter).sort({ lastMessageAt: -1, createdAt: -1 }).skip(skip).limit(query.limit),
      SupportTicketModel.countDocuments(filter),
    ]);

    return { tickets, total };
  }

  public async updateStatusById(
    id: string,
    status: SupportTicketStatus,
    modifiedBy: SupportTicketModifier,
  ): Promise<ISupportTicket | null> {
    return SupportTicketModel.findByIdAndUpdate(
      id,
      {
        $set: {
          status,
          closedAt: status === "pending" ? null : new Date(),
          lastModifiedBy: modifiedBy,
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async appendAdminMessage(id: string, payload: AppendMessageRecord): Promise<ISupportTicket | null> {
    const now = new Date();

    return SupportTicketModel.findByIdAndUpdate(
      id,
      {
        $push: {
          messages: {
            senderType: "admin",
            senderId: payload.senderId,
            senderName: payload.senderName,
            title: "Support Response",
            body: payload.body,
            createdAt: now,
          },
        },
        $set: {
          lastMessageAt: now,
          lastModifiedBy: payload.modifiedBy,
        },
      },
      { new: true, runValidators: true },
    );
  }

  private buildFilter(query: ListSupportTicketsQuery): FilterQuery<ISupportTicket> {
    const filter: FilterQuery<ISupportTicket> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.search) {
      const regex = new RegExp(escapeRegExp(query.search), "i");
      filter.$or = [{ requesterName: regex }, { requesterEmail: regex }, { title: regex }];
    }

    return filter;
  }
}
