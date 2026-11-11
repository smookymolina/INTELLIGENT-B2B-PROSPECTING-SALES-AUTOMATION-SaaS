import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { DiscoveryImportRequest, DiscoverySearchRequest, type DiscoveryImportDto, type DiscoverySearchDto } from "@prospecting/contracts";
import type { AuthContext } from "../../auth/auth.types.js";
import { Auth, RequirePermission } from "../../auth/decorators.js";
import { ZodPipe } from "../../auth/zod.pipe.js";
import { DiscoveryService } from "./discovery.service.js";

/** Registered before ProspectsController so `/prospects/discovery` is never captured by `/prospects/:id`. Same permission as the CSV import. */
@Controller("prospects/discovery")
export class DiscoveryController {
  constructor(@Inject(DiscoveryService) private readonly discovery: DiscoveryService) {}

  /** Preview only: nothing is stored. */
  @Post("search")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  search(@Auth() auth: AuthContext, @Body(new ZodPipe(DiscoverySearchRequest)) body: DiscoverySearchRequest): Promise<DiscoverySearchDto> {
    return this.discovery.search(auth, body);
  }

  @Post("import")
  @HttpCode(200)
  @RequirePermission("prospects:manage")
  import(@Auth() auth: AuthContext, @Body(new ZodPipe(DiscoveryImportRequest)) body: DiscoveryImportRequest): Promise<DiscoveryImportDto> {
    return this.discovery.import(auth, body);
  }
}
