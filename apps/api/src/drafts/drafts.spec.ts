import { describe, expect, it } from "vitest";
import { CreateDraftRequest } from "@prospecting/contracts";
import { maskAddress } from "./drafts.service.js";

const base = { contactId: "6f9619ff-8b86-4011-b42d-00c04fc964ff", evidenceRefs: [] };

describe("maskAddress", () => {
  it("keeps only the first character of an email and the last two digits of a phone", () => {
    expect(maskAddress("compras@acme.example")).toBe("c***@acme.example");
    expect(maskAddress("+5215512345678")).toBe("***78");
  });
});

describe("CreateDraftRequest", () => {
  it("requires a subject for email, forbids it for WhatsApp, and caps WhatsApp bodies at 1024", () => {
    expect(CreateDraftRequest.safeParse({ ...base, channel: "email", body: "hola" }).success).toBe(false);
    expect(CreateDraftRequest.safeParse({ ...base, channel: "email", subject: "s", body: "hola" }).success).toBe(true);
    expect(CreateDraftRequest.safeParse({ ...base, channel: "whatsapp", subject: "s", body: "hola" }).success).toBe(false);
    expect(CreateDraftRequest.safeParse({ ...base, channel: "whatsapp", body: "a".repeat(1024) }).success).toBe(true);
    expect(CreateDraftRequest.safeParse({ ...base, channel: "whatsapp", body: "a".repeat(1025) }).success).toBe(false);
  });
  it("rejects NUL characters and unknown fields", () => {
    expect(CreateDraftRequest.safeParse({ ...base, channel: "whatsapp", body: "a\u0000b" }).success).toBe(false);
    expect(CreateDraftRequest.safeParse({ ...base, channel: "whatsapp", body: "ok", status: "approved" }).success).toBe(false);
  });
});
