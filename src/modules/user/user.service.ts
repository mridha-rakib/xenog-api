import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import {
  createPaginationMeta,
  getPaginationOptions,
  type PaginatedResult,
} from "../../core/utils/pagination.js";
import type { CreateUserDto, IUser, UpdateUserDto } from "./user.interface.js";
import { UserRepository } from "./user.repository.js";

interface ListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  role?: "user" | "admin";
  isActive?: boolean;
}

export class UserService {
  public constructor(private readonly userRepository = new UserRepository()) {}

  public async create(payload: CreateUserDto): Promise<IUser> {
    const existingUser = await this.userRepository.findByEmail(payload.email);

    if (existingUser) {
      throw new AppError("Email already exists", httpStatus.CONFLICT);
    }

    return this.userRepository.create(payload);
  }

  public async list(query: ListUsersQuery): Promise<PaginatedResult<IUser>> {
    const { page, limit, skip } = getPaginationOptions(query);
    const filter: Record<string, unknown> = {};

    if (query.search) {
      filter.$or = [
        { name: { $regex: query.search, $options: "i" } },
        { email: { $regex: query.search, $options: "i" } },
      ];
    }

    if (query.role) {
      filter.role = query.role;
    }

    if (typeof query.isActive === "boolean") {
      filter.isActive = query.isActive;
    }

    const [data, total] = await Promise.all([
      this.userRepository.findMany(filter, skip, limit),
      this.userRepository.count(filter),
    ]);

    return {
      data,
      meta: createPaginationMeta(page, limit, total),
    };
  }

  public async getById(id: string): Promise<IUser> {
    const user = await this.userRepository.findById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }

  public async update(id: string, payload: UpdateUserDto): Promise<IUser> {
    const user = await this.userRepository.updateById(id, payload);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }

  public async delete(id: string): Promise<IUser> {
    const user = await this.userRepository.deleteById(id);

    if (!user) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    return user;
  }
}
