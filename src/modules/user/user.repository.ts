import type { FilterQuery, UpdateQuery } from "mongoose";
import { UserModel } from "./user.model.js";
import type { CreateUserDto, IUser, UpdateUserDto } from "./user.interface.js";

type UserCreateRecord = Omit<CreateUserDto, "password"> & {
  passwordHash?: string;
  emailVerified?: boolean;
  emailVerificationCodeHash?: string;
  emailVerificationExpiresAt?: Date;
};

export class UserRepository {
  public async create(payload: UserCreateRecord): Promise<IUser> {
    return UserModel.create(payload);
  }

  public async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  public async findByIdWithPassword(id: string): Promise<IUser | null> {
    return UserModel.findById(id).select("+passwordHash");
  }

  public async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase() });
  }

  public async findByEmailWithPassword(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase() }).select("+passwordHash");
  }

  public async findByEmailOrUsernameWithPassword(identifier: string): Promise<IUser | null> {
    const normalizedIdentifier = identifier.trim().replace(/^@+/, "").toLowerCase();

    return UserModel.findOne({
      $or: [{ email: normalizedIdentifier }, { username: normalizedIdentifier }],
    }).select("+passwordHash");
  }

  public async findByEmailWithVerification(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase() }).select(
      "+emailVerificationCodeHash +emailVerificationExpiresAt",
    );
  }

  public async findByUsername(username: string): Promise<IUser | null> {
    return UserModel.findOne({ username: username.toLowerCase() });
  }

  public async findByEmailExcludingId(email: string, excludedId: string): Promise<IUser | null> {
    return UserModel.findOne({
      email: email.toLowerCase(),
      _id: { $ne: excludedId },
    });
  }

  public async findByUsernameExcludingId(username: string, excludedId: string): Promise<IUser | null> {
    return UserModel.findOne({
      username: username.toLowerCase(),
      _id: { $ne: excludedId },
    });
  }

  public async updateVerificationById(
    id: string,
    verification: {
      emailVerificationCodeHash: string;
      emailVerificationExpiresAt: Date;
    },
  ): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(id, verification, { new: true, runValidators: true });
  }

  public async markEmailVerified(id: string): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(
      id,
      {
        emailVerified: true,
        $unset: {
          emailVerificationCodeHash: "",
          emailVerificationExpiresAt: "",
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async findMany(filter: FilterQuery<IUser>, skip: number, limit: number): Promise<IUser[]> {
    return UserModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  }

  public async findSuggestedUsers(excludedIds: string[], limit: number): Promise<IUser[]> {
    return UserModel.find({
      _id: { $nin: excludedIds },
      role: "user",
      isActive: true,
      emailVerified: true,
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
  }

  public async findFriendsByIds(friendIds: string[], search: string | undefined, limit: number): Promise<IUser[]> {
    if (friendIds.length === 0) {
      return [];
    }

    const filter: FilterQuery<IUser> = {
      _id: { $in: friendIds },
      role: "user",
      isActive: true,
      emailVerified: true,
    };
    const normalizedSearch = search?.trim().replace(/^@/, "");

    if (normalizedSearch) {
      const escapedSearch = normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { username: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    return UserModel.find(filter).sort({ name: 1, username: 1 }).limit(limit);
  }

  public async count(filter: FilterQuery<IUser>): Promise<number> {
    return UserModel.countDocuments(filter);
  }

  public async updateById(id: string, payload: UpdateUserDto): Promise<IUser | null> {
    const update: UpdateQuery<IUser> = payload;
    return UserModel.findByIdAndUpdate(id, update, { new: true, runValidators: true });
  }

  public async updatePasswordById(id: string, passwordHash: string): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(
      id,
      { passwordHash, passwordChangedAt: new Date() },
      { new: true, runValidators: true },
    );
  }

  public async deleteById(id: string): Promise<IUser | null> {
    return UserModel.findByIdAndDelete(id);
  }
}
