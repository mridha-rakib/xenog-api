import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { SupportTicketRepository } from "./support-ticket.repository.js";
import type {
  CreateSupportTicketDto,
  CreateSupportTicketMessageDto,
  ISupportTicket,
  ListSupportTicketsQuery,
  SupportTicketListResponse,
  SupportTicketModifier,
  SupportTicketResponse,
  UpdateSupportTicketStatusDto,
} from "./support-ticket.interface.js";

export class SupportTicketService {
  public constructor(private readonly supportTicketRepository = new SupportTicketRepository()) {}

  public async createTicket(payload: CreateSupportTicketDto, user: AuthUser): Promise<SupportTicketResponse> {
    const title = payload.title.trim();
    const description = payload.description.trim();
    const now = new Date();

    const ticket = await this.supportTicketRepository.create({
      userId: user.id,
      requesterName: user.name,
      requesterEmail: user.email,
      requesterAvatarKey: user.avatarKey ?? null,
      title,
      description,
      now,
    });

    return this.toResponse(ticket);
  }

  public async listTickets(query: ListSupportTicketsQuery): Promise<SupportTicketListResponse> {
    const { tickets, total } = await this.supportTicketRepository.findMany(query);
    const totalPages = Math.ceil(total / query.limit);
    const from = total === 0 ? 0 : (query.page - 1) * query.limit + 1;
    const to = total === 0 ? 0 : Math.min(query.page * query.limit, total);

    return {
      tickets: tickets.map((ticket) => this.toResponse(ticket)),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        from,
        to,
      },
    };
  }

  public async getTicket(id: string): Promise<SupportTicketResponse> {
    const ticket = await this.supportTicketRepository.findById(id);

    if (!ticket) {
      throw new AppError("Support ticket not found", httpStatus.NOT_FOUND);
    }

    return this.toResponse(ticket);
  }

  public async updateTicketStatus(
    id: string,
    payload: UpdateSupportTicketStatusDto,
    adminUser: AuthUser,
  ): Promise<SupportTicketResponse> {
    const ticket = await this.supportTicketRepository.updateStatusById(
      id,
      payload.status,
      this.toModifier(adminUser),
    );

    if (!ticket) {
      throw new AppError("Support ticket not found", httpStatus.NOT_FOUND);
    }

    return this.toResponse(ticket);
  }

  public async createAdminMessage(
    id: string,
    payload: CreateSupportTicketMessageDto,
    adminUser: AuthUser,
  ): Promise<SupportTicketResponse> {
    const ticket = await this.supportTicketRepository.appendAdminMessage(id, {
      body: payload.body.trim(),
      senderId: adminUser.id,
      senderName: adminUser.name,
      modifiedBy: this.toModifier(adminUser),
    });

    if (!ticket) {
      throw new AppError("Support ticket not found", httpStatus.NOT_FOUND);
    }

    return this.toResponse(ticket);
  }

  private toModifier(user: AuthUser): SupportTicketModifier {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
    };
  }

  private toResponse(ticket: ISupportTicket): SupportTicketResponse {
    return {
      id: ticket._id.toString(),
      requester: {
        id: ticket.userId.toString(),
        name: ticket.requesterName,
        email: ticket.requesterEmail,
        avatarKey: ticket.requesterAvatarKey ?? null,
        avatarUrl: null,
      },
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      messages: ticket.messages.map((message) => ({
        id: message._id.toString(),
        senderType: message.senderType,
        senderId: message.senderId,
        senderName: message.senderName,
        title: message.title,
        body: message.body,
        createdAt: message.createdAt,
      })),
      lastMessageAt: ticket.lastMessageAt,
      closedAt: ticket.closedAt ?? null,
      lastModifiedBy: ticket.lastModifiedBy,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }
}
