import type { AppDirectory } from "../growth/presence.js";

export type AppleAppStoreOptions = {timeoutMs?: number; limit?: number; endpoint?: string};

export class AppleAppStoreDirectory implements AppDirectory {
  constructor(private readonly options: AppleAppStoreOptions = {}) {}

  async search(input: {name: string; locality: string; countryCode: string}) {
    const url = new URL(this.options.endpoint ?? "https://itunes.apple.com/search");
    url.searchParams.set("term", `${input.name} ${input.locality}`.trim());
    url.searchParams.set("country", input.countryCode.toUpperCase());
    url.searchParams.set("entity", "software");
    url.searchParams.set("limit", String(this.options.limit ?? 10));
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000)});
      if (!response.ok) return [];
      const payload = await response.json() as {results?: Array<{trackName?: string; sellerName?: string; trackViewUrl?: string}>};
      return (payload.results ?? []).map(result => ({store: "apple" as const, title: result.trackName ?? "", publisher: result.sellerName ?? "", url: result.trackViewUrl ?? ""}));
    } catch { return []; }
  }
}
