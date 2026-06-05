import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { CreatePlanDto, ListPlansQuery, UpdatePlanDto } from "./plan.interface.js";
import { PlanService } from "./plan.service.js";

export class PlanController {
  public constructor(private readonly planService = new PlanService()) {}

  public createPlan = async (req: Request, res: Response): Promise<void> => {
    const plan = await this.planService.createPlan(req.authUser as AuthUser, req.body as CreatePlanDto);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Plan created",
      data: {
        plan,
      },
    });
  };

  public listMyPlans = async (req: Request, res: Response): Promise<void> => {
    const plans = await this.planService.listMyPlans(req.authUser as AuthUser, req.query as ListPlansQuery);

    ApiResponse.success(res, {
      message: "Plans retrieved",
      data: {
        plans,
      },
    });
  };

  public getPlan = async (req: Request, res: Response): Promise<void> => {
    const plan = await this.planService.getPlan(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Plan retrieved",
      data: {
        plan,
      },
    });
  };

  public updatePlan = async (req: Request, res: Response): Promise<void> => {
    const plan = await this.planService.updatePlan(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as UpdatePlanDto,
    );

    ApiResponse.success(res, {
      message: "Plan updated",
      data: {
        plan,
      },
    });
  };

  public deletePlan = async (req: Request, res: Response): Promise<void> => {
    await this.planService.deletePlan(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Plan deleted",
      data: {
        id: req.params.id,
      },
    });
  };
}
