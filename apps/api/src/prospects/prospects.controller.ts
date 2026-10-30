import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateProspectRequest,
  CreateSuppressionRequest,
  ProspectListQuery,
  SetProspectStatusRequest,
  UpdateProspectRequest,
  UuidParam,
  type ConnectorsDto,
  type ProspectDetailDto,
  type ProspectDto,
  type ProspectPageDto,
  type SuppressionDto,
  type SuppressionListDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { ProspectsService } from "./prospects.service.js";

const idPipe = () => new ZodPipe(UuidParam);

/** Fixed routes (connectors) are declared before `:id`; the imports controller is registered before this one in the module. */
@Controller("prospects")
export class ProspectsController {
  constructor(@Inject(ProspectsService) private readonly prospects: ProspectsService) {}

  @Get()
  @RequirePermission("prospects:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(ProspectListQuery)) q: ProspectListQuery): Promise<ProspectPageDto> {
    return this.prospects.list(auth, q);
  }

  @Post()
  @RequirePermission("prospects:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateProspectRequest)) body: CreateProspectRequest): Promise<ProspectDto> {
    return this.prospects.create(auth, body);
  }

  @Get("connectors")
  @RequirePermission("prospects:read")
  connectors(): ConnectorsDto {
    return this.prospects.connectors();
  }

  @Get(":id")
  @RequirePermission("prospects:read")
  get(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string): Promise<ProspectDetailDto> {
    return this.prospects.get(auth, id);
  }

  @Patch(":id")
  @RequirePermission("prospects:manage")
  update(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string, @Body(new ZodPipe(UpdateProspectRequest)) body: UpdateProspectRequest): Promise<ProspectDto> {
    return this.prospects.update(auth, id, body);
  }

  @Post(":id/status")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  setStatus(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string, @Body(new ZodPipe(SetProspectStatusRequest)) body: SetProspectStatusRequest): Promise<ProspectDto> {
    return this.prospects.setStatus(auth, id, body);
  }
}

@Controller("suppressions")
export class SuppressionsController {
  constructor(@Inject(ProspectsService) private readonly prospects: ProspectsService) {}

  @Get()
  @RequirePermission("prospects:read")
  list(@Auth() auth: AuthContext): Promise<SuppressionListDto> {
    return this.prospects.listSuppressions(auth);
  }

  @Post()
  @RequirePermission("suppressions:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateSuppressionRequest)) body: CreateSuppressionRequest): Promise<SuppressionDto> {
    return this.prospects.createSuppression(auth, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("suppressions:remove")
  remove(@Auth() auth: AuthContext, @Param("id", idPipe()) id: string): Promise<void> {
    return this.prospects.removeSuppression(auth, id);
  }
}
