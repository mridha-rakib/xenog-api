import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { ProductService } from "./product.service.js";

export class ProductController {
  public constructor(private readonly productService = new ProductService()) {}

  public createProduct = async (req: Request, res: Response): Promise<void> => {
    const product = await this.productService.createProduct(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Product created",
      data: {
        product,
      },
    });
  };

  public listMyProducts = async (req: Request, res: Response): Promise<void> => {
    const products = await this.productService.listMyProducts(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Products retrieved",
      data: {
        products,
      },
    });
  };

  public listPublishedProductsByUser = async (req: Request, res: Response): Promise<void> => {
    const products = await this.productService.listPublishedProductsByUser(req.params.userId as string);

    ApiResponse.success(res, {
      message: "Products retrieved",
      data: {
        products,
      },
    });
  };

  public getMyProduct = async (req: Request, res: Response): Promise<void> => {
    const product = await this.productService.getMyProduct(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Product retrieved",
      data: {
        product,
      },
    });
  };

  public getPublishedProduct = async (req: Request, res: Response): Promise<void> => {
    const product = await this.productService.getPublishedProduct(req.params.id as string);

    ApiResponse.success(res, {
      message: "Product retrieved",
      data: {
        product,
      },
    });
  };

  public updateMyProduct = async (req: Request, res: Response): Promise<void> => {
    const product = await this.productService.updateMyProduct(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body,
    );

    ApiResponse.success(res, {
      message: "Product updated",
      data: {
        product,
      },
    });
  };

  public deleteMyProduct = async (req: Request, res: Response): Promise<void> => {
    await this.productService.deleteMyProduct(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Product deleted",
      data: null,
    });
  };
}
