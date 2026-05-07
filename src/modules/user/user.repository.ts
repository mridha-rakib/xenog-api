import type { FilterQuery, UpdateQuery } from "mongoose";
import { UserModel } from "./user.model.js";
import type { CreateUserDto, IUser, UpdateUserDto } from "./user.interface.js";

export class UserRepository {
  public async create(payload: CreateUserDto): Promise<IUser> {
    return UserModel.create(payload);
  }

  public async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  public async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase() });
  }

  public async findMany(filter: FilterQuery<IUser>, skip: number, limit: number): Promise<IUser[]> {
    return UserModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  }

  public async count(filter: FilterQuery<IUser>): Promise<number> {
    return UserModel.countDocuments(filter);
  }

  public async updateById(id: string, payload: UpdateUserDto): Promise<IUser | null> {
    const update: UpdateQuery<IUser> = payload;
    return UserModel.findByIdAndUpdate(id, update, { new: true, runValidators: true });
  }

  public async deleteById(id: string): Promise<IUser | null> {
    return UserModel.findByIdAndDelete(id);
  }
}
