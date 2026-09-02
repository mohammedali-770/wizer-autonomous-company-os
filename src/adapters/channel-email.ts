import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationAdapter } from "../integrations.js";

type SendInput = {to: string; subject: string; text: string; previewUrl: string};
const asSend = (operation: string, input: unknown) => {
  if (operation !== "send.email") throw new Error(`This channel only sends email; ${operation} needs its own reviewed adapter`);
  const payload = input as Partial<SendInput>;
  if (!payload?.to || !payload.subject || !payload.text) throw new Error("send.email needs to, subject and text");
  return payload as SendInput;
};

export type ResendOptions = {apiKey: string; from: string; replyTo: string; optOutMailto: string; endpoint?: string; timeoutMs?: number};

export class ResendEmailChannel implements IntegrationAdapter {
  constructor(private readonly options: ResendOptions) {}
  async execute(operation: string, input: unknown, idempotencyKey: string) {
    const payload = asSend(operation, input);
    const response = await fetch(this.options.endpoint ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: {authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey},
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20000),
      body: JSON.stringify({
        from: this.options.from, to: [payload.to], reply_to: this.options.replyTo,
        subject: payload.subject, text: payload.text,
        headers: {"List-Unsubscribe": `<${this.options.optOutMailto}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}
      })
    });
    const body = await response.json().catch(() => ({})) as {id?: string; message?: string};
    if (!response.ok) throw new Error(`Email send failed (${response.status}): ${body.message ?? "unknown error"}`);
    return {id: body.id ?? idempotencyKey, provider: "resend"};
  }
}

export class DryRunOutreachChannel implements IntegrationAdapter {
  constructor(private readonly options: {directory: string}) {}
  async execute(operation: string, input: unknown, idempotencyKey: string) {
    const payload = asSend(operation, input);
    await mkdir(this.options.directory, {recursive: true});
    const path = join(this.options.directory, `${idempotencyKey.replace(/[^\w.-]+/g, "_")}.txt`);
    await writeFile(path, `To: ${payload.to}\nSubject: ${payload.subject}\n\n${payload.text}\n`, "utf8");
    return {id: `dry-run:${idempotencyKey}`, provider: "dry_run", path, sent: false};
  }
}
