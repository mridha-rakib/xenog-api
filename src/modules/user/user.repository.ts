import type { FilterQuery, UpdateQuery } from "mongoose";
import { UserModel } from "./user.model.js";
import type { CreateUserDto, IUser, UpdateUserDto } from "./user.interface.js";
import { escapeRegExp } from "./people-search-ranking.js";

export interface PeopleSearchCandidateQuery {
  normalizedQuery: string;
  /** Ids removed before ranking (viewer + blocked + blockers). Never includes "already-followed". */
  excludedIds: string[];
  prefixLimit: number;
  nameLimit: number;
  totalTarget: number;
}

type UserCreateRecord = Omit<CreateUserDto, "password"> & {
  passwordHash?: string;
  emailVerified?: boolean;
  emailVerificationCodeHash?: string;
  emailVerificationExpiresAt?: Date;
  passwordResetCodeHash?: string;
  passwordResetExpiresAt?: Date;
};

export class UserRepository {
  public async create(payload: UserCreateRecord): Promise<IUser> {
    return UserModel.create(payload);
  }

  public async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  public async findByIds(ids: string[]): Promise<IUser[]> {
    if (ids.length === 0) {
      return [];
    }

    return UserModel.find({ _id: { $in: ids } });
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

  public async findByEmailWithPasswordReset(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase() }).select(
      "+passwordHash +passwordResetCodeHash +passwordResetExpiresAt",
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

  public async updatePasswordResetById(
    id: string,
    reset: {
      passwordResetCodeHash: string;
      passwordResetExpiresAt: Date;
    },
  ): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(id, reset, { new: true, runValidators: true });
  }

  public async clearPasswordResetById(id: string): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(
      id,
      {
        $unset: {
          passwordResetCodeHash: "",
          passwordResetExpiresAt: "",
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async updatePasswordWithResetById(
    id: string,
    passwordHash: string,
    currentPasswordResetCodeHash: string,
  ): Promise<IUser | null> {
    return UserModel.findOneAndUpdate(
      {
        _id: id,
        passwordResetCodeHash: currentPasswordResetCodeHash,
      },
      {
        $set: {
          passwordHash,
          passwordChangedAt: new Date(),
        },
        $unset: {
          passwordResetCodeHash: "",
          passwordResetExpiresAt: "",
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

  public async findActiveUsersByIds(userIds: string[], search: string | undefined, limit: number): Promise<IUser[]> {
    if (userIds.length === 0) {
      return [];
    }

    const filter: FilterQuery<IUser> = {
      _id: { $in: userIds },
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

  /**
   * Bounded, lexical-band candidate retrieval for authenticated People search.
   *
   * Eligibility (role/isActive/emailVerified/deletedAt + excludedIds) is applied
   * inside every band so ineligible accounts never reach ranking. "Already
   * followed" is intentionally NOT excluded here (that belongs to
   * recommendations, not search).
   *
   * The exact-username row is fetched directly and returned separately so it can
   * never be lost to a weak-substring candidate cap. Strong bands (username
   * prefix, display-name boundary match) are collected before the weak
   * substring backfill tops the set up to `totalTarget`.
   */
  public async findPeopleSearchCandidates(
    params: PeopleSearchCandidateQuery,
  ): Promise<{ exact: IUser | null; candidates: IUser[] }> {
    const { normalizedQuery, excludedIds, prefixLimit, nameLimit, totalTarget } = params;

    if (!normalizedQuery) {
      return { exact: null, candidates: [] };
    }

    const escaped = escapeRegExp(normalizedQuery);
    const eligibility: FilterQuery<IUser> = {
      _id: { $nin: excludedIds },
      role: "user",
      isActive: true,
      emailVerified: true,
      deletedAt: null,
    };

    // T0 — direct exact-username lookup (usernames are stored lowercase + unique).
    const exact = await UserModel.findOne({ ...eligibility, username: normalizedQuery });

    // T1 — username prefix. Case-sensitive anchored regex: stored usernames are
    // already lowercase and the query is normalized lowercase, so this stays
    // index-eligible (no `$options: "i"`).
    // T2/T3 — display-name boundary match (full-name prefix or token prefix);
    // the pure ranker assigns the precise tier.
    const [prefixMatches, nameMatches] = await Promise.all([
      UserModel.find({ ...eligibility, username: { $regex: `^${escaped}` } }).limit(prefixLimit),
      UserModel.find({ ...eligibility, name: { $regex: `\\b${escaped}`, $options: "i" } }).limit(nameLimit),
    ]);

    const collected = new Map<string, IUser>();
    if (exact) {
      collected.set(exact._id.toString(), exact);
    }
    for (const user of prefixMatches) {
      collected.set(user._id.toString(), user);
    }
    for (const user of nameMatches) {
      collected.set(user._id.toString(), user);
    }

    // T4 — weak substring backfill, only up to the remaining candidate budget and
    // only for rows not already collected by a stronger band.
    const remaining = totalTarget - collected.size;
    if (remaining > 0) {
      const weakMatches = await UserModel.find({
        ...eligibility,
        _id: { $nin: [...excludedIds, ...collected.keys()] },
        $or: [
          { username: { $regex: escaped, $options: "i" } },
          { name: { $regex: escaped, $options: "i" } },
        ],
      }).limit(remaining);
      for (const user of weakMatches) {
        collected.set(user._id.toString(), user);
      }
    }

    const exactId = exact?._id.toString();
    const candidates = [...collected.values()].filter((user) => user._id.toString() !== exactId);

    return { exact, candidates };
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

  public async deactivateAccountById(id: string): Promise<IUser | null> {
    const deletedAccountToken = `deleted-${id}`;

    return UserModel.findByIdAndUpdate(
      id,
      {
        $set: {
          name: "Deleted User",
          email: `${deletedAccountToken}@deleted.local`,
          contact: null,
          avatarKey: null,
          gender: null,
          age: null,
          bio: null,
          address: null,
          businessDocumentKey: null,
          currentLocationSharingEnabled: false,
          currentLocation: null,
          notificationsEnabled: false,
          isActive: false,
          emailVerified: false,
          deletedAt: new Date(),
          passwordChangedAt: new Date(),
        },
        $unset: {
          username: "",
          passwordHash: "",
          emailVerificationCodeHash: "",
          emailVerificationExpiresAt: "",
          passwordResetCodeHash: "",
          passwordResetExpiresAt: "",
        },
      },
      { new: true, runValidators: true },
    );
  }
}
