import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateCategoryRequest,
  CreateItemRequest,
  ItemListQuery,
  UpdateCategoryRequest,
  UpdateItemDraftRequest,
  UuidParam,
  type CategoryDto,
  type ItemDto,
  type ItemPageDto,
  type ItemVersionDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { CatalogService } from "./catalog.service.js";

const idPipe = new ZodPipe(UuidParam);

/** Tenant comes from the session. Reads need catalog:read, edits catalog:manage; approve/archive/restore need catalog:approve. */
@Controller("catalog")
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get("categories")
  @RequirePermission("catalog:read")
  listCategories(@Auth() auth: AuthContext): Promise<CategoryDto[]> {
    return this.catalog.listCategories(auth);
  }

  @Post("categories")
  @RequirePermission("catalog:manage")
  createCategory(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateCategoryRequest)) body: CreateCategoryRequest): Promise<CategoryDto> {
    return this.catalog.createCategory(auth, body);
  }

  @Patch("categories/:id")
  @RequirePermission("catalog:manage")
  updateCategory(@Auth() auth: AuthContext, @Param("id", idPipe) id: string, @Body(new ZodPipe(UpdateCategoryRequest)) body: UpdateCategoryRequest): Promise<CategoryDto> {
    return this.catalog.updateCategory(auth, id, body);
  }

  @Get("items")
  @RequirePermission("catalog:read")
  listItems(@Auth() auth: AuthContext, @Query(new ZodPipe(ItemListQuery)) query: ItemListQuery): Promise<ItemPageDto> {
    return this.catalog.listItems(auth, query);
  }

  @Post("items")
  @RequirePermission("catalog:manage")
  createItem(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateItemRequest)) body: CreateItemRequest): Promise<ItemDto> {
    return this.catalog.createItem(auth, body);
  }

  @Get("items/:id")
  @RequirePermission("catalog:read")
  getItem(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemDto> {
    return this.catalog.getItem(auth, id);
  }

  @Patch("items/:id")
  @RequirePermission("catalog:manage")
  updateDraft(@Auth() auth: AuthContext, @Param("id", idPipe) id: string, @Body(new ZodPipe(UpdateItemDraftRequest)) body: UpdateItemDraftRequest): Promise<ItemDto> {
    return this.catalog.updateDraft(auth, id, body);
  }

  @Get("items/:id/versions")
  @RequirePermission("catalog:read")
  listVersions(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemVersionDto[]> {
    return this.catalog.listVersions(auth, id);
  }

  @Post("items/:id/versions")
  @RequirePermission("catalog:manage")
  createDraft(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemDto> {
    return this.catalog.createDraft(auth, id);
  }

  @Post("items/:id/approve")
  @HttpCode(200)
  @RequirePermission("catalog:approve")
  approve(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemDto> {
    return this.catalog.approve(auth, id);
  }

  @Post("items/:id/archive")
  @HttpCode(200)
  @RequirePermission("catalog:approve")
  archive(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemDto> {
    return this.catalog.archive(auth, id);
  }

  @Post("items/:id/restore")
  @HttpCode(200)
  @RequirePermission("catalog:approve")
  restore(@Auth() auth: AuthContext, @Param("id", idPipe) id: string): Promise<ItemDto> {
    return this.catalog.restore(auth, id);
  }
}
