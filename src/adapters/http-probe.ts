import { lookup } from "node:dns/promises";
import type { WebProbe } from "../growth/presence.js";

export type WebProbeOptions = {userAgent: string; timeoutMs?: number; maxBytes?: number; minHostIntervalMs?: number; respectRobots?: boolean};
type RobotsRules = {allow: string[]; disallow: string[]};

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const decodeEntities = (value: string) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

export const extractTitle = (html: string) => decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
export const visibleTextLength = (html: string) =>
  decodeEntities(html.replace(/<(script|style|noscript|template|head)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().length;

export const parseRobots = (text: string, userAgentToken: string): RobotsRules => {
  const groups: Array<{agents: string[]; rules: RobotsRules}> = [];
  let current: {agents: string[]; rules: RobotsRules} | null = null, previousWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#")[0]!.trim();
    if (!clean) continue;
    const [rawField, ...rest] = clean.split(":");
    const field = rawField!.trim().toLowerCase(), value = rest.join(":").trim();
    if (field === "user-agent") {
      if (!current || !previousWasAgent) { current = {agents: [], rules: {allow: [], disallow: []}}; groups.push(current); }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }
    previousWasAgent = false;
    if (!current) continue;
    if (field === "disallow") current.rules.disallow.push(value);
    if (field === "allow") current.rules.allow.push(value);
  }
  const token = userAgentToken.toLowerCase();
  return groups.find(group => group.agents.some(agent => agent !== "*" && token.includes(agent)))?.rules
    ?? groups.find(group => group.agents.includes("*"))?.rules
    ?? {allow: [], disallow: []};
};

export const robotsAllows = (rules: RobotsRules, path: string) => {
  const longest = (patterns: string[]) => patterns.filter(pattern => pattern && path.startsWith(pattern)).reduce((best, pattern) => Math.max(best, pattern.length), -1);
  if (rules.disallow.includes("/") && !rules.allow.length) return false;
  const allowed = longest(rules.allow), disallowed = longest(rules.disallow);
  return disallowed === -1 || allowed >= disallowed;
};

export class PoliteWebProbe implements WebProbe {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly robotsCache = new Map<string, RobotsRules>();
  private readonly userAgentToken: string;
  constructor(private readonly options: WebProbeOptions) { this.userAgentToken = options.userAgent.split("/")[0]!.toLowerCase(); }

  private async throttle(host: string) {
    const interval = this.options.minHostIntervalMs ?? 1500, previous = this.lastRequestAt.get(host);
    if (previous !== undefined) { const remaining = previous + interval - Date.now(); if (remaining > 0) await wait(remaining); }
    this.lastRequestAt.set(host, Date.now());
  }

  private async request(url: string) {
    const target = new URL(url);
    await this.throttle(target.hostname);
    return fetch(target, {redirect: "follow", signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000), headers: {"user-agent": this.options.userAgent, accept: "text/html,application/xhtml+xml"}});
  }

  private async readCapped(response: Response) {
    const limit = this.options.maxBytes ?? 512000;
    if (!response.body) return "";
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", {fatal: false});
    let read = 0, text = "";
    while (read < limit) {
      const {done, value} = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, {stream: true});
    }
    await reader.cancel().catch(() => {});
    return text;
  }

  private async robotsFor(origin: string) {
    if (this.options.respectRobots === false) return {allow: [], disallow: []};
    const cached = this.robotsCache.get(origin);
    if (cached) return cached;
    let rules: RobotsRules = {allow: [], disallow: []};
    try {
      const response = await this.request(`${origin}/robots.txt`);
      if (response.ok) rules = parseRobots(await this.readCapped(response), this.userAgentToken);
      else await response.body?.cancel();
    } catch { rules = {allow: [], disallow: []}; }
    this.robotsCache.set(origin, rules);
    return rules;
  }

  async resolve(hostname: string) {
    try { await lookup(hostname); return {resolves: true}; }
    catch { return {resolves: false}; }
  }

  async fetch(url: string) {
    const target = new URL(url);
    const rules = await this.robotsFor(target.origin);
    if (!robotsAllows(rules, target.pathname)) return {status: 0, finalUrl: url, title: "", textLength: 0, contentLength: 0, blocked: true};
    try {
      const response = await this.request(url);
      const html = await this.readCapped(response);
      return {status: response.status, finalUrl: response.url || url, title: extractTitle(html), textLength: visibleTextLength(html), contentLength: html.length, blocked: false};
    } catch {
      return {status: 0, finalUrl: url, title: "", textLength: 0, contentLength: 0, blocked: false};
    }
  }
}
