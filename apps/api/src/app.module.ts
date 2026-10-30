import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditModule } from "./audit/audit.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { PermissionsGuard } from "./auth/permissions.guard.js";
import { DbModule } from "./db/db.module.js";
import { HttpSupportModule } from "./http/http.module.js";
import { HealthModule } from "./health/health.module.js";
import { InvitationsModule } from "./invitations/invitations.module.js";
import { ProspectsModule } from "./prospects/prospects.module.js";
import { PricingModule } from "./pricing/pricing.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { CompanyModule } from "./company/company.module.js";
import { MembershipsModule } from "./memberships/memberships.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";

// Guards run in order: authentication (session -> tenant context), then RBAC. Routes are private unless marked @Public().
@Module({
  imports: [DbModule, HttpSupportModule, HealthModule, AuditModule, AuthModule, OrganizationsModule, MembershipsModule, InvitationsModule, CompanyModule, CatalogModule, PricingModule, ProspectsModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
