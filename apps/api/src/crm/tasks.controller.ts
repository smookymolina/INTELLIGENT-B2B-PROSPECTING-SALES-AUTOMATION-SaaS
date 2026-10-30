import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { CreateTaskRequest, TaskListQuery, UuidParam, type TaskDto, type TaskPageDto } from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { TasksService } from "./tasks.service.js";

const id = () => new ZodPipe(UuidParam);

/** Sellers pass crm:read / crm:work; the database only shows and lets them touch tasks of opportunities assigned to them. */
@Controller()
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Post("opportunities/:id/tasks")
  @RequirePermission("crm:work")
  create(@Auth() auth: AuthContext, @Param("id", id()) oid: string, @Body(new ZodPipe(CreateTaskRequest)) body: CreateTaskRequest): Promise<TaskDto> {
    return this.tasks.create(auth, oid, body);
  }

  @Get("opportunities/:id/tasks")
  @RequirePermission("crm:read")
  forOpportunity(@Auth() auth: AuthContext, @Param("id", id()) oid: string, @Query(new ZodPipe(TaskListQuery)) q: TaskListQuery): Promise<TaskPageDto> {
    return this.tasks.list(auth, q, oid);
  }

  @Get("tasks")
  @RequirePermission("crm:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(TaskListQuery)) q: TaskListQuery): Promise<TaskPageDto> {
    return this.tasks.list(auth, q);
  }

  @Post("tasks/:id/complete")
  @HttpCode(200)
  @RequirePermission("crm:work")
  complete(@Auth() auth: AuthContext, @Param("id", id()) tid: string): Promise<TaskDto> {
    return this.tasks.complete(auth, tid);
  }

  @Post("tasks/:id/cancel")
  @HttpCode(200)
  @RequirePermission("crm:work")
  cancel(@Auth() auth: AuthContext, @Param("id", id()) tid: string): Promise<TaskDto> {
    return this.tasks.cancel(auth, tid);
  }
}
