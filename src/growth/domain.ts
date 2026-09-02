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

export type OutreachPolicy = {
  senderIdentity: {legalName: string; postalAddress: string; replyToEmail: string; websiteUrl: string};
  allowedChannels: OutreachChannel[];
  jurisdictions: Record<string, {unsolicitedBusinessEmail: "opt_out_allowed" | "consent_required"; phoneRequiresRegistryCheck: boolean}>;
  maxTouchesPerProspect: number; minDaysBetweenTouches: number; quietHours: {startHour: number; endHour: number};
  dailySendCap: number; requireHumanApproval: boolean;
};

export interface SuppressionList {
  contains(input: {companyId: string; value: string}): Promise<boolean>;
  add(input: {companyId: string; value: string; reason: string; at: string}): Promise<void>;
}

export interface ApprovalGate {
  request(input: {companyId: string; kind: string; subject: string; payload: unknown; idempotencyKey: string}): Promise<{approvalId: string; status: "pending" | "approved" | "rejected"; approvedBy?: string}>;
}
