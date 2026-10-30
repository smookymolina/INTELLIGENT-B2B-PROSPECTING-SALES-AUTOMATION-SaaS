import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { IdempotencyKeyHeader, LoginRequest, RegisterRequest, SwitchOrganizationRequest, type MeDto, type MyOrganizationsDto, type SessionDto } from "@prospecting/contracts";
import { IdempotencyService } from "../http/idempotency.service.js";
import { AuthService } from "./auth.service.js";
import type { AuthContext } from "./auth.types.js";
import { Auth, ClientIp, Public, RequestId } from "./decorators.js";
import { ZodPipe } from "./zod.pipe.js";

const idempotencyKeyPipe = new ZodPipe(IdempotencyKeyHeader);
const idempotencyKey = (headers: Record<string, string | undefined>) => idempotencyKeyPipe.transform(headers["idempotency-key"]);

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  @Public()
  @Post("auth/register")
  async register(
    @Body(new ZodPipe(RegisterRequest)) body: RegisterRequest,
    @RequestId() requestId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const key = idempotencyKey(headers);
    const { value, replayed } = await this.idempotency.run({ scope: "register", key, fingerprint: body }, () => this.auth.register(body, requestId));
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return value;
  }

  @Public()
  @Post("auth/login")
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginRequest)) body: LoginRequest, @RequestId() requestId: string, @ClientIp() ip: string): Promise<SessionDto> {
    return this.auth.login(body, requestId, ip);
  }

  @Post("auth/switch-organization")
  @HttpCode(200)
  switchOrganization(@Auth() auth: AuthContext, @Body(new ZodPipe(SwitchOrganizationRequest)) body: SwitchOrganizationRequest): Promise<SessionDto> {
    return this.auth.switchOrganization(auth, body.organizationSlug);
  }

  @Post("auth/logout")
  @HttpCode(204)
  logout(@Auth() auth: AuthContext): Promise<void> {
    return this.auth.logout(auth);
  }

  @Get("me/organizations")
  myOrganizations(@Auth() auth: AuthContext): Promise<MyOrganizationsDto> {
    return this.auth.myOrganizations(auth);
  }

  @Get("me")
  me(@Auth() auth: AuthContext): Promise<MeDto> {
    return this.auth.me(auth);
  }
}
