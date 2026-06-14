import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { CartService } from "./cart.service.js";

export class CartController {
  public constructor(private readonly cartService = new CartService()) {}

  public getCart = async (req: Request, res: Response): Promise<void> => {
    const cart = await this.cartService.getCart(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Cart retrieved",
      data: {
        cart,
      },
    });
  };

  public addItem = async (req: Request, res: Response): Promise<void> => {
    const cart = await this.cartService.addItem(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Cart item added",
      data: {
        cart,
      },
    });
  };

  public updateItem = async (req: Request, res: Response): Promise<void> => {
    const cart = await this.cartService.updateItem(
      req.authUser as AuthUser,
      req.params.productId as string,
      req.body,
    );

    ApiResponse.success(res, {
      message: "Cart item updated",
      data: {
        cart,
      },
    });
  };

  public removeItem = async (req: Request, res: Response): Promise<void> => {
    const cart = await this.cartService.removeItem(req.authUser as AuthUser, req.params.productId as string);

    ApiResponse.success(res, {
      message: "Cart item removed",
      data: {
        cart,
      },
    });
  };

  public clearCart = async (req: Request, res: Response): Promise<void> => {
    const cart = await this.cartService.clearCart(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Cart cleared",
      data: {
        cart,
      },
    });
  };
}
