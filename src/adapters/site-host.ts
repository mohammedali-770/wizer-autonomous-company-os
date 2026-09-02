import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationAdapter } from "../integrations.js";

type PublishInput = {siteId: string; html: string; indexable: boolean; takedownToken: string; businessName: string};
const asPublish = (input: unknown) => {
  const payload = input as Partial<PublishInput>;
  if (!payload?.siteId || typeof payload.html !== "string") throw new Error("publish_preview needs a siteId and html");
  if (payload.indexable) throw new Error("Refusing to publish an indexable preview of someone else's business");
  return payload as PublishInput;
};

export class LocalDirectorySiteHost implements IntegrationAdapter {
  constructor(private readonly options: {directory: string; baseUrl: string}) {}
  async execute(operation: string, input: unknown) {
    if (operation === "publish_preview") {
      const payload = asPublish(input);
      await mkdir(this.options.directory, {recursive: true});
      const path = join(this.options.directory, `${payload.siteId}.html`);
      await writeFile(path, payload.html, "utf8");
      return {url: `${this.options.baseUrl.replace(/\/$/, "")}/${payload.siteId}.html`, path};
    }
    if (operation === "unpublish_preview") {
      const {siteId} = input as {siteId: string};
      await rm(join(this.options.directory, `${siteId}.html`), {force: true});
      return {removed: siteId};
    }
    throw new Error(`Site host does not support ${operation}`);
  }
}

export class SupabaseStorageSiteHost implements IntegrationAdapter {
  constructor(private readonly client: SupabaseClient, private readonly bucket = "demo-previews") {}
  async execute(operation: string, input: unknown) {
    const storage = this.client.storage.from(this.bucket);
    if (operation === "publish_preview") {
      const payload = asPublish(input);
      const path = `${payload.siteId}/index.html`;
      const {error} = await storage.upload(path, new Blob([payload.html], {type: "text/html; charset=utf-8"}), {contentType: "text/html; charset=utf-8", upsert: true, cacheControl: "300"});
      if (error) throw new Error(`Preview upload failed: ${error.message}`);
      return {url: storage.getPublicUrl(path).data.publicUrl, path};
    }
    if (operation === "unpublish_preview") {
      const {siteId} = input as {siteId: string};
      const {error} = await storage.remove([`${siteId}/index.html`]);
      if (error) throw new Error(`Preview takedown failed: ${error.message}`);
      return {removed: siteId};
    }
    throw new Error(`Site host does not support ${operation}`);
  }
}
