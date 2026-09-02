import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../domain.js";
import type { ApprovalGate, SuppressionList } from "../growth/domain.js";

export const suppressionHash = (value: string) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

export class InMemoryStore implements Store {
  readonly appended: Array<{operation: string; input: unknown}> = [];
  async query<T>(operation: string): Promise<T> {
    const empty: Record<string, unknown> = {"prospects.known_fingerprints": [], "outreach.touches": [], "growth.campaign_signals": [], "outreach.sent_today": 0, "memory.recall": [], "scheduler.claim_due": [], "outreach.approved_pending": []};
    return (operation in empty ? empty[operation] : null) as T;
  }
  async append(operation: string, input: unknown) { this.appended.push({operation, input}); }
  recordsOf(operation: string) { return this.appended.filter(entry => entry.operation === operation).map(entry => entry.input); }
}

export class InMemorySuppressionList implements SuppressionList {
  private readonly values = new Set<string>();
  constructor(seed: string[] = []) { for (const value of seed) this.values.add(suppressionHash(value)); }
  async contains(input: {companyId: string; value: string}) { return this.values.has(suppressionHash(input.value)); }
  async add(input: {companyId: string; value: string}) { this.values.add(suppressionHash(input.value)); }
}

export class FixedApprovalGate implements ApprovalGate {
  constructor(private readonly status: "pending" | "approved" | "rejected" = "pending", private readonly approvedBy = "cli") {}
  async request() { return {approvalId: randomUUID(), status: this.status, ...(this.status === "approved" ? {approvedBy: this.approvedBy} : {})}; }
}
