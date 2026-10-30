import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import {
  ClonePriceListRequest,
  CreatePriceListRequest,
  PageQuery,
  PriceListQuery,
  SetPriceRequest,
  UpdatePriceListRequest,
  UuidParam,
  type ApprovedPricePageDto,
  type PriceEntryDto,
  type PriceEntryPageDto,
  type PriceListDto,
  type PriceListPageDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { PricingService } from "./pricing.service.js";

const id = () => new ZodPipe(UuidParam);

/** Same permissions as the catalog (ADR-018): read all, manage org_admin+sales_manager, approve/archive org_admin. */
@Controller("catalog/price-lists")
export class PricingController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Get()
  @RequirePermission("catalog:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(PriceListQuery)) q: PriceListQuery): Promise<PriceListPageDto> {
    return this.pricing.listLists(auth, q);
  }

  @Post()
  @RequirePermission("catalog:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreatePriceListRequest)) body: CreatePriceListRequest): Promise<PriceListDto> {
    return this.pricing.createList(auth, body);
  }

  @Get(":id")
  @RequirePermission("catalog:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) listId: string): Promise<PriceListDto> {
    return this.pricing.getList(auth, listId);
  }

  @Patch(":id")
  @RequirePermission("catalog:manage")
  update(@Auth() auth: AuthContext, @Param("id", id()) listId: string, @Body(new ZodPipe(UpdatePriceListRequest)) body: UpdatePriceListRequest): Promise<PriceListDto> {
    return this.pricing.updateList(auth, listId, body);
  }

  @Post(":id/clone")
  @RequirePermission("catalog:manage")
  clone(@Auth() auth: AuthContext, @Param("id", id()) listId: string, @Body(new ZodPipe(ClonePriceListRequest)) body: ClonePriceListRequest): Promise<PriceListDto> {
    return this.pricing.clone(auth, listId, body);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("catalog:approve")
  approve(@Auth() auth: AuthContext, @Param("id", id()) listId: string): Promise<PriceListDto> {
    return this.pricing.approve(auth, listId);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @RequirePermission("catalog:approve")
  archive(@Auth() auth: AuthContext, @Param("id", id()) listId: string): Promise<PriceListDto> {
    return this.pricing.archive(auth, listId);
  }

  @Get(":id/entries")
  @RequirePermission("catalog:read")
  entries(@Auth() auth: AuthContext, @Param("id", id()) listId: string, @Query(new ZodPipe(PageQuery)) q: PageQuery): Promise<PriceEntryPageDto> {
    return this.pricing.listEntries(auth, listId, q);
  }

  @Put(":id/entries/:itemId")
  @HttpCode(200)
  @RequirePermission("catalog:manage")
  setPrice(
    @Auth() auth: AuthContext,
    @Param("id", id()) listId: string,
    @Param("itemId", id()) itemId: string,
    @Body(new ZodPipe(SetPriceRequest)) body: SetPriceRequest,
  ): Promise<PriceEntryDto> {
    return this.pricing.setPrice(auth, listId, itemId, body);
  }

  @Delete(":id/entries/:itemId")
  @HttpCode(204)
  @RequirePermission("catalog:manage")
  removePrice(@Auth() auth: AuthContext, @Param("id", id()) listId: string, @Param("itemId", id()) itemId: string): Promise<void> {
    return this.pricing.removePrice(auth, listId, itemId);
  }

  @Get(":id/approved-prices")
  @RequirePermission("catalog:read")
  approvedPrices(@Auth() auth: AuthContext, @Param("id", id()) listId: string, @Query(new ZodPipe(PageQuery)) q: PageQuery): Promise<ApprovedPricePageDto> {
    return this.pricing.listApprovedPrices(auth, listId, q);
  }
}
