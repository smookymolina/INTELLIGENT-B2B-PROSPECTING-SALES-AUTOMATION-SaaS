import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { BranchDto, CreateBranchRequest, ProfileDto, UpdateBranchRequest, UpdateProfileRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";

const UNIQUE_VIOLATION = "P2002";
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();

type ProfileRow = {
  legal_name: string | null; trade_name: string | null; industry: string | null; website: string | null; description: string | null;
  country: string | null; timezone: string | null; default_currency: string | null; updated_at: Date;
};
const EMPTY_PROFILE: ProfileDto = { legalName: null, tradeName: null, industry: null, website: null, description: null, country: null, timezone: null, defaultCurrency: null, updatedAt: null };
const profileDto = (r: ProfileRow): ProfileDto => ({
  legalName: r.legal_name, tradeName: r.trade_name, industry: r.industry, website: r.website, description: r.description,
  country: r.country, timezone: r.timezone, defaultCurrency: r.default_currency, updatedAt: r.updated_at.toISOString(),
});

const branchSelect = { id: true, name: true, address: true, city: true, region: true, country: true, status: true } as const;
type BranchRow = { id: string; name: string; address: string | null; city: string | null; region: string | null; country: string | null; status: "active" | "disabled" };
const branchDto = (r: BranchRow): BranchDto => ({ id: r.id, name: r.name, address: r.address, city: r.city, region: r.region, country: r.country, status: r.status });

const isUnique = (e: unknown) => (e as { code?: string }).code === UNIQUE_VIOLATION;
const duplicateBranch = () => new ApiException(409, "CONFLICT", "A branch with that name already exists");

@Injectable()
export class CompanyService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  getProfile(auth: AuthContext): Promise<ProfileDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.organizationProfile.findFirst({ where: { organization_id: auth.organizationId } });
      return row ? profileDto(row) : EMPTY_PROFILE;
    });
  }

  replaceProfile(auth: AuthContext, input: UpdateProfileRequest): Promise<ProfileDto> {
    const data = {
      legal_name: input.legalName ?? null, trade_name: input.tradeName ?? null, industry: input.industry ?? null, website: input.website ?? null,
      description: input.description ?? null, country: input.country ?? null, timezone: input.timezone ?? null, default_currency: input.defaultCurrency ?? null,
    };
    return this.db.withTenant(auth, async (tx) => {
      const before = await tx.organizationProfile.findFirst({ where: { organization_id: auth.organizationId } });
      const row = await tx.organizationProfile.upsert({
        where: { organization_id: auth.organizationId },
        create: { organization_id: auth.organizationId, ...data },
        update: data,
      });
      // Audit records which fields changed, never their values (profile text may contain business details).
      const changed = (Object.keys(data) as Array<keyof typeof data>).filter((k) => (before?.[k] ?? null) !== data[k]);
      await this.audit.record(tx, auth, { action: "organization.profile_updated", resourceType: "organization", resourceId: auth.organizationId, metadata: { changedFields: changed } });
      return profileDto(row);
    });
  }

  listBranches(auth: AuthContext): Promise<BranchDto[]> {
    return this.db.withTenant(auth, async (tx) => {
      const rows = await tx.branch.findMany({ where: { organization_id: auth.organizationId }, select: branchSelect, orderBy: [{ name_key: "asc" }, { id: "asc" }] });
      return rows.map(branchDto);
    });
  }

  async createBranch(auth: AuthContext, input: CreateBranchRequest): Promise<BranchDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const row = await tx.branch.create({
          data: {
            organization_id: auth.organizationId, name: input.name, name_key: nameKey(input.name),
            address: input.address ?? null, city: input.city ?? null, region: input.region ?? null, country: input.country ?? null,
          },
          select: branchSelect,
        });
        await this.audit.record(tx, auth, { action: "branch.created", resourceType: "branch", resourceId: row.id });
        return branchDto(row);
      });
    } catch (e) {
      throw isUnique(e) ? duplicateBranch() : e;
    }
  }

  async updateBranch(auth: AuthContext, id: string, input: UpdateBranchRequest): Promise<BranchDto> {
    try {
      return await this.db.withTenant(auth, async (tx) => {
        const current = await tx.branch.findFirst({ where: { id, organization_id: auth.organizationId }, select: branchSelect });
        if (!current) throw new NotFoundException();
        const row = await tx.branch.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name, name_key: nameKey(input.name) } : {}),
            ...(input.address !== undefined ? { address: input.address } : {}),
            ...(input.city !== undefined ? { city: input.city } : {}),
            ...(input.region !== undefined ? { region: input.region } : {}),
            ...(input.country !== undefined ? { country: input.country } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
          },
          select: branchSelect,
        });
        await this.audit.record(tx, auth, {
          action: input.status && input.status !== current.status ? `branch.${input.status === "disabled" ? "disabled" : "enabled"}` : "branch.updated",
          resourceType: "branch",
          resourceId: id,
          metadata: { changedFields: Object.keys(input) },
        });
        return branchDto(row);
      });
    } catch (e) {
      throw isUnique(e) ? duplicateBranch() : e;
    }
  }
}
