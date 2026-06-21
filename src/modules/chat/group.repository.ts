import { Types } from "mongoose";
import type { IGroup, IGroupMessage } from "./group.interface.js";
import { GroupMessageModel } from "./group-message.model.js";
import { GroupModel } from "./group.model.js";

interface CreateGroupRecord {
  name: string;
  avatarKey?: string | null;
  createdBy: string;
  memberIds: string[];
}

interface CreateGroupMessageRecord {
  groupId: string;
  senderId: string;
  text: string;
}

export class GroupRepository {
  public async create(payload: CreateGroupRecord): Promise<IGroup> {
    const members = payload.memberIds.map((userId) => ({
      userId: new Types.ObjectId(userId),
      role: userId === payload.createdBy ? ("admin" as const) : ("member" as const),
      joinedAt: new Date(),
    }));

    return GroupModel.create({
      name: payload.name,
      avatarKey: payload.avatarKey ?? null,
      createdBy: new Types.ObjectId(payload.createdBy),
      members,
    });
  }

  public async findById(id: string): Promise<IGroup | null> {
    return GroupModel.findById(id);
  }

  public async findGroupsForUser(userId: string, limit: number): Promise<IGroup[]> {
    return GroupModel.find({ "members.userId": new Types.ObjectId(userId) })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(limit);
  }

  public async isMember(groupId: string, userId: string): Promise<boolean> {
    const exists = await GroupModel.exists({
      _id: groupId,
      "members.userId": new Types.ObjectId(userId),
    });

    return Boolean(exists);
  }

  public async updateLastMessage(groupId: string, text: string, at: Date): Promise<void> {
    await GroupModel.findByIdAndUpdate(groupId, {
      lastMessage: text,
      lastMessageAt: at,
    });
  }

  public async createMessage(payload: CreateGroupMessageRecord): Promise<IGroupMessage> {
    return GroupMessageModel.create({
      groupId: new Types.ObjectId(payload.groupId),
      senderId: new Types.ObjectId(payload.senderId),
      text: payload.text,
    });
  }

  public async findMessages(groupId: string, limit: number, before?: Date): Promise<IGroupMessage[]> {
    const filter: Record<string, unknown> = { groupId: new Types.ObjectId(groupId) };

    if (before) {
      filter.createdAt = { $lt: before };
    }

    return GroupMessageModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
  }

  public async getMemberIds(groupId: string): Promise<string[]> {
    const group = await GroupModel.findById(groupId).select("members");

    if (!group) {
      return [];
    }

    return group.members.map((m) => m.userId.toString());
  }
}
