import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CreateTaskRequest, TaskDto, TaskListQuery, TaskPageDto } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const conflict = (message: string) => new ApiException(409, "CONFLICT", message);
const dbMessage = (e: unknown) => String((e as { message?: string }).message ?? "");

function mapDbError(e: unknown): never {
  const m = dbMessage(e);
  if (m.includes("closed opportunity")) throw conflict("The opportunity is closed");
  if (m.includes("assignee must be")) throw conflict("The assignee must be an active seller, sales manager or admin of this organization");
  if (m.includes("closed task cannot change")) throw conflict("The task is already closed");
  if (m.includes("row-level security") || m.includes("insufficient_privilege")) throw new ApiException(403, "FORBIDDEN", "Not allowed");
  throw e;
}

type TaskRow = {
  id: string; opportunity_id: string; title: string; due_at: Date; state: string; assignee_user_id: string; created_by: string; created_at: Date; completed_at: Date | null;
  opportunity: { title: string };
};
const INCLUDE = { opportunity: { select: { title: true } } } as const;

const toDto = (r: TaskRow, now = Date.now()): TaskDto => ({
  id: r.id, opportunityId: r.opportunity_id, opportunityTitle: r.opportunity.title, title: r.title, dueAt: r.due_at.toISOString(), state: r.state as TaskDto["state"],
  assigneeUserId: r.assignee_user_id, createdBy: r.created_by, createdAt: r.created_at.toISOString(), completedAt: r.completed_at?.toISOString() ?? null,
  overdue: r.state === "open" && r.due_at.getTime() < now,
});

/** Follow-up tasks. Visibility, work rights and the open/done/cancelled machine are enforced by PostgreSQL (RLS + trigger); this layer shapes input and output. */
@Injectable()
export class TasksService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  create(auth: AuthContext, opportunityId: string, input: CreateTaskRequest): Promise<TaskDto> {
    return this.db
      .withTenant(auth, async (tx) => {
        const opp = await tx.opportunity.findFirst({ where: { id: opportunityId, organization_id: auth.organizationId }, select: { id: true, owner_user_id: true } });
        if (!opp) throw new NotFoundException();
        const assignee = input.assigneeUserId ?? opp.owner_user_id ?? auth.userId;
        const row = await tx.opportunityTask.create({
          data: { organization_id: auth.organizationId, opportunity_id: opportunityId, title: input.title, due_at: new Date(input.dueAt), assignee_user_id: assignee, created_by: auth.userId },
          include: INCLUDE,
        });
        await this.audit.record(tx, auth, { action: "task.created", resourceType: "opportunity_task", resourceId: row.id, metadata: { opportunityId, assignee } });
        return toDto(row);
      })
      .catch(mapDbError);
  }

  list(auth: AuthContext, q: TaskListQuery, opportunityId?: string): Promise<TaskPageDto> {
    return this.db.withTenant(auth, async (tx) => {
      if (opportunityId && !(await tx.opportunity.findFirst({ where: { id: opportunityId, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
      const now = new Date();
      const assignee = q.assignee === "me" ? auth.userId : q.assignee;
      const cursor = q.cursor ? await tx.opportunityTask.findFirst({ where: { id: q.cursor, organization_id: auth.organizationId }, select: { id: true, due_at: true } }) : null;
      if (q.cursor && !cursor) throw new NotFoundException();
      const rows = await tx.opportunityTask.findMany({
        where: {
          organization_id: auth.organizationId,
          ...(opportunityId ? { opportunity_id: opportunityId } : {}),
          ...(q.state !== "all" ? { state: q.state } : {}),
          ...(assignee ? { assignee_user_id: assignee } : {}),
          ...(q.overdue === "true" ? { state: "open", due_at: { lt: now } } : {}),
          ...(cursor ? { OR: [{ due_at: { gt: cursor.due_at } }, { due_at: cursor.due_at, id: { gt: cursor.id } }] } : {}),
        },
        orderBy: [{ due_at: "asc" }, { id: "asc" }],
        take: q.limit + 1,
        include: INCLUDE,
      });
      const page = rows.slice(0, q.limit);
      return { items: page.map((r) => toDto(r, now.getTime())), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    });
  }

  complete(auth: AuthContext, id: string): Promise<TaskDto> {
    return this.close(auth, id, "done");
  }

  cancel(auth: AuthContext, id: string): Promise<TaskDto> {
    return this.close(auth, id, "cancelled");
  }

  private close(auth: AuthContext, id: string, state: "done" | "cancelled"): Promise<TaskDto> {
    return this.db
      .withTenant(auth, async (tx: Tx) => {
        if (!(await tx.opportunityTask.findFirst({ where: { id, organization_id: auth.organizationId }, select: { id: true } }))) throw new NotFoundException();
        // completed_at / completed_by are stamped by the trigger from the database clock and the session user.
        const row = await tx.opportunityTask.update({ where: { id }, data: { state }, include: INCLUDE });
        await this.audit.record(tx, auth, { action: state === "done" ? "task.completed" : "task.cancelled", resourceType: "opportunity_task", resourceId: id });
        return toDto(row);
      })
      .catch(mapDbError);
  }
}
