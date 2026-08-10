import { z } from "zod";

export const Agent = z.object({
  id: z.string().uuid(), companyId: z.string().uuid(), name: z.string().min(1), title: z.string().min(1),
  departmentId: z.string().uuid().nullable(), status: z.enum(["active", "paused", "retired"]),
  mandate: z.string(), personality: z.object({worldview:z.string(), reasoningStyle:z.string(), riskPosture:z.string(), communicationStyle:z.string()}),
  authority: z.array(z.string()), modelPolicy: z.record(z.unknown()).default({})
});
export type Agent = z.infer<typeof Agent>;
export type CompanyContext = { companyId:string; generatedAt:string; constitution:string[]; strategy:unknown; organization:unknown; operations:unknown; finance:unknown; customers:unknown; product:unknown; risks:unknown; recentEvents:unknown[]; decisions:unknown[]; openQuestions:unknown[] };
export type WorkProposal = { objective:string; rationale:string; expectedOutcome:string; requestedActions:Array<{capability:string; risk:"low"|"medium"|"high"; input:unknown}>; stopConditions:string[]; confidence:number };
export type ModelMessage = { role:"system"|"user"|"assistant"; content:string };
export interface ReasoningModel { complete(messages:ModelMessage[], options:{model?:string; temperature?:number; responseSchema?:unknown}):Promise<string> }
export interface Store { query<T>(operation:string, input?:unknown):Promise<T>; append(operation:string, input:unknown):Promise<void> }
