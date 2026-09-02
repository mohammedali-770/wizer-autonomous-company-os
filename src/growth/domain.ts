import { z } from "zod";

export const OutreachChannel = z.enum(["email", "phone", "postal", "contact_form", "messaging"]);
export type OutreachChannel = z.infer<typeof OutreachChannel>;

export const ContactPoint = z.object({
  channel: OutreachChannel, value: z.string().min(1), publiclyListed: z.boolean(),
  consent: z.enum(["none", "opt_in"]).default("none"), source: z.string().min(1), collectedAt: z.string().min(1)
});
export type ContactPoint = z.infer<typeof ContactPoint>;

export const BusinessProspect = z.object({
  id: z.string().min(1), companyId: z.string().min(1), source: z.string().min(1), sourceRef: z.string().min(1),
  name: z.string().min(1), category: z.string().default(""),
  address: z.object({line: z.string().default(""), locality: z.string().default(""), region: z.string().default(""), postalCode: z.string().default(""), countryCode: z.string().length(2)}),
  timezone: z.string().default("UTC"), declaredWebsite: z.string().nullable().default(null),
  socialProfiles: z.array(z.object({network: z.string(), url: z.string()})).default([]),
  contacts: z.array(ContactPoint).default([]), discoveredAt: z.string().min(1), retainUntil: z.string().nullable().default(null)
});
export type BusinessProspect = z.infer<typeof BusinessProspect>;

export const PresenceSignal = z.object({
  kind: z.enum(["directory_field", "dns", "http", "content", "app_store", "social", "manual"]),
  observation: z.string().min(1), evidenceUrl: z.string().nullable().default(null), observedAt: z.string().min(1)
});
export type PresenceSignal = z.infer<typeof PresenceSignal>;

export type WebsitePresence = "none" | "broken" | "social_only" | "platform_hosted" | "owned";
export type AppPresence = "none" | "published" | "unknown";

export const PresenceAssessment = z.object({
  prospectId: z.string().min(1), website: z.custom<WebsitePresence>(), app: z.custom<AppPresence>(),
  gapScore: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
  signals: z.array(PresenceSignal), assessedAt: z.string().min(1)
});
export type PresenceAssessment = z.infer<typeof PresenceAssessment>;

export type Qualification = {qualified: boolean; reasons: string[]; gapScore: number; confidence: number};

export type DemoSiteContent = {
  headline: string; subheadline: string; about: string;
  sections: Array<{title: string; body: string}>;
  callToAction: string; placeholders: string[];
};

export type DemoSite = {
  id: string; prospectId: string; content: DemoSiteContent; html: string; disclosure: string;
  takedownToken: string; checksum: string; indexable: false; builtAt: string; previewUrl: string | null;
};

export type OutreachMessage = {
  prospectId: string; channel: OutreachChannel; to: string; subject: string; body: string;
  previewUrl: string; senderIdentityBlock: string; contactSourceDisclosure: string; optOutInstruction: string;
  touch: number; composedAt: string;
};

export type OutreachTouch = {prospectId: string; channel: OutreachChannel; sentAt: string; outcome: "sent" | "bounced" | "replied" | "opted_out"};

export const OutreachPolicy = z.object({
  senderIdentity: z.object({legalName: z.string().min(1), postalAddress: z.string().min(1), replyToEmail: z.string().email(), websiteUrl: z.string().url()}),
  allowedChannels: z.array(OutreachChannel).min(1),
  jurisdictions: z.record(z.string().length(2), z.object({unsolicitedBusinessEmail: z.enum(["opt_out_allowed", "consent_required"]), phoneRequiresRegistryCheck: z.boolean()})),
  maxTouchesPerProspect: z.number().int().min(1).max(5),
  minDaysBetweenTouches: z.number().int().min(1),
  quietHours: z.object({startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23)}),
  dailySendCap: z.number().int().min(1),
  requireHumanApproval: z.boolean()
});
export type OutreachPolicy = z.infer<typeof OutreachPolicy>;

export const DEMO_SITE_CONTENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "subheadline", "about", "sections", "callToAction", "placeholders"],
  properties: {
    headline: {type: "string"}, subheadline: {type: "string"}, about: {type: "string"},
    sections: {type: "array", items: {type: "object", additionalProperties: false, required: ["title", "body"], properties: {title: {type: "string"}, body: {type: "string"}}}},
    callToAction: {type: "string"}, placeholders: {type: "array", items: {type: "string"}}
  }
} as const;

export const OUTREACH_COPY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["subject", "body"],
  properties: {subject: {type: "string"}, body: {type: "string"}}
} as const;

export interface SuppressionList {
  contains(input: {companyId: string; value: string}): Promise<boolean>;
  add(input: {companyId: string; value: string; reason: string; at: string}): Promise<void>;
}

export interface ApprovalGate {
  request(input: {companyId: string; kind: string; subject: string; payload: unknown; idempotencyKey: string}): Promise<{approvalId: string; status: "pending" | "approved" | "rejected"; approvedBy?: string}>;
}
