import mongoose, { Types } from "mongoose";
import type { ClientSession } from "mongoose";
import type { ChatMessageAttachment, ChatMessageType } from "./chat.interface.js";
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
  type?: ChatMessageType;
  text?: string;
  attachment?: ChatMessageAttachment | null;
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

  public async updateLastMessage(groupId: string, text: string | null, at: Date | null): Promise<void> {
    await GroupModel.findByIdAndUpdate(groupId, {
      lastMessage: text,
      lastMessageAt: at,
    });
  }

  public async createMessage(payload: CreateGroupMessageRecord): Promise<IGroupMessage> {
    return GroupMessageModel.create({
      groupId: new Types.ObjectId(payload.groupId),
      senderId: new Types.ObjectId(payload.senderId),
      type: payload.type ?? "text",
      text: payload.text ?? "",
      attachment: payload.attachment ?? null,
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

  public async findMessageById(id: string): Promise<IGroupMessage | null> {
    return GroupMessageModel.findById(id);
  }

  public async findLatestMessage(groupId: string): Promise<IGroupMessage | null> {
    return GroupMessageModel.findOne({ groupId: new Types.ObjectId(groupId) })
      .sort({ createdAt: -1, _id: -1 });
  }

  public async updateOwnedMessageText(
    id: string,
    senderId: string,
    text: string,
  ): Promise<IGroupMessage | null> {
    return GroupMessageModel.findOneAndUpdate(
      { _id: id, senderId: new Types.ObjectId(senderId) },
      { $set: { text, editedAt: new Date() } },
      { new: true },
    );
  }

  public async deleteOwnedMessage(id: string, senderId: string): Promise<IGroupMessage | null> {
    return GroupMessageModel.findOneAndDelete({
      _id: id,
      senderId: new Types.ObjectId(senderId),
    });
  }

  public async getMemberIds(groupId: string): Promise<string[]> {
    const group = await GroupModel.findById(groupId).select("members");

    if (!group) {
      return [];
    }

    return group.members.map((m) => m.userId.toString());
  }

  // Runs `fn` inside a Mongo session/transaction, matching the pattern used
  // in event-window.repository.ts's createPostWithCapacity. withTransaction
  // re-runs `fn` on retryable transient errors (e.g. write conflicts from a
  // concurrent leave on the same group), so `fn` must be idempotent to rerun.
  public async runTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();

    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  public async findByIdInSession(groupId: string, session: ClientSession): Promise<IGroup | null> {
    return GroupModel.findById(groupId).session(session);
  }

  // Atomically removes `userId` from `members`, guarded on the caller still
  // being a current, non-owner member at write time. Returns false if the
  // guard didn't match (already removed / no longer applicable), so callers
  // can treat that as a state-changed conflict rather than silently no-op.
  public async pullNonOwnerMember(
    groupId: string,
    userId: string,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await GroupModel.updateOne(
      {
        _id: groupId,
        createdBy: { $ne: new Types.ObjectId(userId) },
        "members.userId": new Types.ObjectId(userId),
      },
      { $pull: { members: { userId: new Types.ObjectId(userId) } } },
      { session },
    );

    return result.modifiedCount === 1;
  }

  // Promotes `newOwnerId` to admin + owner. Guarded on them still being a
  // current member and the caller still being the current owner.
  public async transferOwnership(
    groupId: string,
    currentOwnerId: string,
    newOwnerId: string,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await GroupModel.updateOne(
      {
        _id: groupId,
        createdBy: new Types.ObjectId(currentOwnerId),
        "members.userId": new Types.ObjectId(newOwnerId),
      },
      {
        $set: {
          createdBy: new Types.ObjectId(newOwnerId),
          "members.$.role": "admin",
        },
      },
      { session },
    );

    return result.modifiedCount === 1;
  }

  // Removes the (now former) owner from `members` after ownership has
  // already been transferred to someone else.
  public async pullFormerOwnerMember(
    groupId: string,
    formerOwnerId: string,
    session: ClientSession,
  ): Promise<boolean> {
    const result = await GroupModel.updateOne(
      {
        _id: groupId,
        createdBy: { $ne: new Types.ObjectId(formerOwnerId) },
        "members.userId": new Types.ObjectId(formerOwnerId),
      },
      { $pull: { members: { userId: new Types.ObjectId(formerOwnerId) } } },
      { session },
    );

    return result.modifiedCount === 1;
  }

  // Deletes the group and every group-message row it directly owns. Only
  // ever called on the sole-remaining-member leave path; scoped strictly to
  // this groupId, so it cannot touch DMs or any other group.
  public async deleteGroupWithMessages(groupId: string, session: ClientSession): Promise<boolean> {
    const deleted = await GroupModel.deleteOne({ _id: groupId }, { session });
    await GroupMessageModel.deleteMany({ groupId: new Types.ObjectId(groupId) }, { session });

    return deleted.deletedCount === 1;
  }
}
