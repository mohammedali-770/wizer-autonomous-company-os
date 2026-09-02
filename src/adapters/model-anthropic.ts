import Anthropic from "@anthropic-ai/sdk";
import type { ModelMessage, ReasoningModel } from "../domain.js";

export type AnthropicModelOptions = {
  apiKey?: string; model?: string; maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxRetries?: number; timeoutMs?: number; refusalFallbacks?: boolean;
};

export const extractJson = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
  const start = candidate.search(/[{[]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start === -1 || end <= start) throw new Error(`Model returned no JSON object: ${text.slice(0, 200)}`);
  return candidate.slice(start, end + 1);
};

const asJsonSchema = (value: unknown) =>
  value && typeof value === "object" && (value as {type?: unknown}).type === "object" ? (value as {[key: string]: unknown}) : null;

export class AnthropicReasoningModel implements ReasoningModel {
  private readonly client: Anthropic;
  constructor(private readonly options: AnthropicModelOptions = {}) {
    this.client = new Anthropic({
      ...(options.apiKey ? {apiKey: options.apiKey} : {}),
      maxRetries: options.maxRetries ?? 3, timeout: options.timeoutMs ?? 120000
    });
  }

  async complete(messages: ModelMessage[], options: {model?: string; temperature?: number; responseSchema?: unknown} = {}) {
    const schema = asJsonSchema(options.responseSchema);
    const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
    const conversation = messages.filter(message => message.role !== "system").map(message => ({role: message.role as "user" | "assistant", content: message.content}));
    if (!conversation.length) throw new Error("A model request needs at least one user message");
    const response = await this.client.beta.messages.create({
      model: options.model ?? this.options.model ?? "claude-opus-5",
      max_tokens: this.options.maxTokens ?? 8000,
      ...(system ? {system} : {}),
      messages: conversation,
      output_config: {effort: this.options.effort ?? "medium", ...(schema ? {format: {type: "json_schema" as const, schema}} : {})},
      ...(this.options.refusalFallbacks === false ? {} : {betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const})
    });
    if (response.stop_reason === "refusal") throw new Error(`Model declined this request (${response.stop_details?.category ?? "unspecified"}); review the prompt and the business record before retrying`);
    const text = response.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
    if (!text) throw new Error(`Model returned no text (stop reason ${response.stop_reason})`);
    return schema || /return only json|return json/i.test(system) ? extractJson(text) : text;
  }
}
