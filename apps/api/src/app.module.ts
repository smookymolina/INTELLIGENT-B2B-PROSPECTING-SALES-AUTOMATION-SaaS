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
import { AiModule } from "./ai/ai.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { SequencesModule } from "./sequences/sequences.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { PrivacyModule } from "./privacy/privacy.module.js";
import { PlatformAdminModule } from "./platform-admin/platform-admin.module.js";
import { DraftsModule } from "./drafts/drafts.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { AttributionModule } from "./attribution/attribution.module.js";
import { QuotesModule } from "./quotes/quotes.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { ScoringModule } from "./scoring/scoring.module.js";
import { PricingModule } from "./pricing/pricing.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { CompanyModule } from "./company/company.module.js";
import { EmailSettingsModule } from "./email-settings/email-settings.module.js";
import { MembershipsModule } from "./memberships/memberships.module.js";
import { OrganizationsModule } from "./organizations/organizations.module.js";

// Guards run in order: authentication (session -> tenant context), then RBAC. Routes are private unless marked @Public().
@Module({
  imports: [DbModule, HttpSupportModule, HealthModule, AuditModule, AuthModule, OrganizationsModule, MembershipsModule, InvitationsModule, CompanyModule, EmailSettingsModule,CatalogModule, PricingModule, ProspectsModule, ScoringModule, CrmModule, NotificationsModule, QuotesModule, AnalyticsModule, AttributionModule, AiModule, CampaignsModule, SequencesModule, JobsModule, DraftsModule, PrivacyModule, PlatformAdminModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
