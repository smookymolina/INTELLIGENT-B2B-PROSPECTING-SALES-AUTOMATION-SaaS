import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import {
  AddQuoteLineRequest,
  CreateQuoteRequest,
  PageQuery,
  QuoteDecisionRequest,
  QuoteListQuery,
  SetQuoteSettingsRequest,
  UpdateQuoteRequest,
  UuidParam,
  type QuoteDetailDto,
  type QuotePageDto,
  type QuoteSettingsDto,
  type SalePageDto,
} from "@prospecting/contracts";
import type { AuthContext } from "../auth/auth.types.js";
import { Auth, RequirePermission } from "../auth/decorators.js";
import { ZodPipe } from "../auth/zod.pipe.js";
import { QuotesService } from "./quotes.service.js";

const id = () => new ZodPipe(UuidParam);

/** `settings` is declared before `:id`. Visibility of quotes follows the opportunity (sellers: their own), enforced by RLS. */
@Controller("quotes")
export class QuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Get()
  @RequirePermission("quotes:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(QuoteListQuery)) q: QuoteListQuery): Promise<QuotePageDto> {
    return this.quotes.list(auth, q);
  }

  @Post()
  @RequirePermission("quotes:manage")
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateQuoteRequest)) body: CreateQuoteRequest): Promise<QuoteDetailDto> {
    return this.quotes.create(auth, body);
  }

  @Get("settings")
  @RequirePermission("quotes:read")
  settings(@Auth() auth: AuthContext): Promise<QuoteSettingsDto> {
    return this.quotes.getSettings(auth);
  }

  @Put("settings")
  @RequirePermission("quotes:approve")
  setSettings(@Auth() auth: AuthContext, @Body(new ZodPipe(SetQuoteSettingsRequest)) body: SetQuoteSettingsRequest): Promise<QuoteSettingsDto> {
    return this.quotes.setSettings(auth, body);
  }

  @Get(":id")
  @RequirePermission("quotes:read")
  get(@Auth() auth: AuthContext, @Param("id", id()) qid: string): Promise<QuoteDetailDto> {
    return this.quotes.get(auth, qid);
  }

  @Get(":id/pdf")
  @RequirePermission("quotes:read")
  async pdf(@Auth() auth: AuthContext, @Param("id", id()) qid: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { filename, body } = await this.quotes.pdf(auth, qid);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(body);
  }

  @Patch(":id")
  @RequirePermission("quotes:manage")
  update(@Auth() auth: AuthContext, @Param("id", id()) qid: string, @Body(new ZodPipe(UpdateQuoteRequest)) body: UpdateQuoteRequest): Promise<QuoteDetailDto> {
    return this.quotes.update(auth, qid, body);
  }

  @Post(":id/lines")
  @RequirePermission("quotes:manage")
  addLine(@Auth() auth: AuthContext, @Param("id", id()) qid: string, @Body(new ZodPipe(AddQuoteLineRequest)) body: AddQuoteLineRequest): Promise<QuoteDetailDto> {
    return this.quotes.addLine(auth, qid, body);
  }

  @Delete(":id/lines/:lineId")
  @RequirePermission("quotes:manage")
  removeLine(@Auth() auth: AuthContext, @Param("id", id()) qid: string, @Param("lineId", id()) lineId: string): Promise<QuoteDetailDto> {
    return this.quotes.removeLine(auth, qid, lineId);
  }

  @Post(":id/approve-discount")
  @HttpCode(200)
  @RequirePermission("quotes:approve")
  approveDiscount(@Auth() auth: AuthContext, @Param("id", id()) qid: string): Promise<QuoteDetailDto> {
    return this.quotes.approveDiscount(auth, qid);
  }

  @Post(":id/send")
  @HttpCode(200)
  @RequirePermission("quotes:manage")
  send(@Auth() auth: AuthContext, @Param("id", id()) qid: string): Promise<QuoteDetailDto> {
    return this.quotes.send(auth, qid);
  }

  @Post(":id/decision")
  @HttpCode(200)
  @RequirePermission("quotes:manage")
  decide(@Auth() auth: AuthContext, @Param("id", id()) qid: string, @Body(new ZodPipe(QuoteDecisionRequest)) body: QuoteDecisionRequest): Promise<QuoteDetailDto> {
    return this.quotes.decide(auth, qid, body);
  }
}

@Controller("sales")
export class SalesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Get()
  @RequirePermission("quotes:read")
  list(@Auth() auth: AuthContext, @Query(new ZodPipe(PageQuery)) q: PageQuery): Promise<SalePageDto> {
    return this.quotes.listSales(auth, q);
  }
}
