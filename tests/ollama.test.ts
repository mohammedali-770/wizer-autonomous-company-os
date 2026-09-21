import {describe,expect,it,vi} from "vitest";
import {z} from "zod";
import {AgentRuntime,APPROVED_AGENTS,OllamaReasoningModel,ollamaFromEnv,recoverJson,type Store} from "../src/index.js";

const store:Store={query:async<T>()=>({} as T),append:vi.fn(async()=>{})};
const reply=(content:string,extra:Record<string,unknown>={})=>new Response(JSON.stringify({model:"m",message:{role:"assistant",content},done:true,...extra}),{status:200,headers:{"content-type":"application/json"}});
const fakeFetch=(...replies:Array<Response|(()=>Response|Promise<Response>)>)=>{
  const calls:Array<{url:string;init:RequestInit;body:any}>=[]; let n=0;
  const impl=(async(input:any,init:any)=>{
    calls.push({url:String(input),init,body:init?.body?JSON.parse(String(init.body)):undefined});
    const next=replies[Math.min(n++,replies.length-1)]!; return typeof next==="function"?next():next.clone();
  }) as unknown as typeof fetch;
  return {impl,calls};
};
const JSON_PROMPT=[{role:"system" as const,content:"Return only JSON matching WorkProposal."},{role:"user" as const,content:"{}"}];
const PROSE_PROMPT=[{role:"system" as const,content:"Speak as Ali, CEO. Disagree honestly."},{role:"user" as const,content:"agenda"}];

describe("recoverJson",()=>{
  it("parses clean json",()=>expect(recoverJson('{"a":1}')).toEqual({a:1}));
  it("unwraps markdown fences",()=>expect(recoverJson('```json\n{"a":1}\n```')).toEqual({a:1}));
  it("ignores preamble and trailing prose",()=>expect(recoverJson('Sure! Here it is:\n{"a":1}\nHope that helps.')).toEqual({a:1}));
  it("keeps braces that live inside strings",()=>expect(recoverJson('{"a":"}{ not a brace"}')).toEqual({a:"}{ not a brace"}));
  it("handles escaped quotes",()=>expect(recoverJson('{"a":"say \\"hi\\""}')).toEqual({a:'say "hi"'}));
  it("recovers arrays",()=>expect(recoverJson("text [1,2] more")).toEqual([1,2]));
  it("throws on unparseable text",()=>expect(()=>recoverJson("no json at all")).toThrow());
});

describe("json mode detection",()=>{
  it("enables json format when the system prompt asks for JSON",async()=>{
    const {impl,calls}=fakeFetch(reply('{"objective":"x"}'));
    await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{});
    expect(calls[0]!.body.format).toBe("json");
  });
  it("leaves prose calls unconstrained",async()=>{
    const {impl,calls}=fakeFetch(reply("I disagree with the growth plan."));
    const text=await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.format).toBeUndefined();
    expect(text).toBe("I disagree with the growth plan.");
  });
  it("never inspects user content for the json hint",async()=>{
    const {impl,calls}=fakeFetch(reply("prose"));
    await new OllamaReasoningModel({fetch:impl}).complete([{role:"system",content:"Speak freely."},{role:"user",content:"the customer asked about our JSON export"}],{});
    expect(calls[0]!.body.format).toBeUndefined();
  });
  it("honours an explicit jsonMode override",async()=>{
    const {impl,calls}=fakeFetch(reply("plain words"));
    await new OllamaReasoningModel({fetch:impl,jsonMode:"never"}).complete(JSON_PROMPT,{});
    expect(calls[0]!.body.format).toBeUndefined();
  });
  it("forwards a json schema to ollama structured output",async()=>{
    const {impl,calls}=fakeFetch(reply('{"a":1}'));
    const schema={type:"object",properties:{a:{type:"number"}},required:["a"]};
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{responseSchema:schema});
    expect(calls[0]!.body.format).toEqual(schema);
  });
});

describe("small model repair",()=>{
  it("returns canonical json when the model fences its answer",async()=>{
    const {impl}=fakeFetch(reply('```json\n{"objective":"ship"}\n```'));
    const raw=await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{});
    expect(JSON.parse(raw)).toEqual({objective:"ship"});
  });
  it("strips reasoning traces before parsing",async()=>{
    const {impl}=fakeFetch(reply('<think>let me plan this out</think>{"objective":"ship"}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({objective:"ship"});
  });
  it("strips reasoning traces from prose replies too",async()=>{
    const {impl}=fakeFetch(reply("<think>hmm</think>We should hold the launch."));
    expect(await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).toBe("We should hold the launch.");
  });
  it("retries once with a corrective turn and zero temperature",async()=>{
    const {impl,calls}=fakeFetch(reply("I cannot do that"),reply('{"objective":"ship"}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({objective:"ship"});
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages).toHaveLength(4);
    expect(calls[1]!.body.messages[3].content).toMatch(/valid JSON value and nothing else/);
    expect(calls[1]!.body.options.temperature).toBe(0);
  });
  it("gives up with an actionable error after the attempt budget",async()=>{
    const {impl,calls}=fakeFetch(reply("still not json"));
    await expect(new OllamaReasoningModel({fetch:impl,maxAttempts:2}).complete(JSON_PROMPT,{})).rejects.toThrow(/did not return a usable reply after 2 attempt/);
    expect(calls).toHaveLength(2);
  });
  it("validates against a zod responseSchema and retries on mismatch",async()=>{
    const {impl,calls}=fakeFetch(reply('{"objective":123}'),reply('{"objective":"ship"}'));
    const schema=z.object({objective:z.string()});
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{responseSchema:schema}))).toEqual({objective:"ship"});
    expect(calls[0]!.body.format).toBe("json");
    expect(calls).toHaveLength(2);
  });
});

describe("request shape",()=>{
  it("sends the pi friendly defaults",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]!.body).toMatchObject({model:"llama3.2:3b",stream:false,keep_alive:"30m",options:{num_ctx:4096,temperature:0.2}});
    expect(calls[0]!.body.think).toBeUndefined();
  });
  it("lets the agent model policy pick the model",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl,model:"llama3.2:3b"}).complete(PROSE_PROMPT,{model:"qwen3:4b",temperature:0.7});
    expect(calls[0]!.body.model).toBe("qwen3:4b");
    expect(calls[0]!.body.options.temperature).toBe(0.7);
  });
  it("trims a trailing slash from the base url",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl,baseUrl:"http://pi.local:11434/"}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://pi.local:11434/api/chat");
  });
  it("records token and load timings",async()=>{
    const {impl}=fakeFetch(reply("ok",{prompt_eval_count:120,eval_count:40,load_duration:2e9,total_duration:9e9}));
    const model=new OllamaReasoningModel({fetch:impl}); await model.complete(PROSE_PROMPT,{});
    expect(model.lastStats()).toMatchObject({promptTokens:120,completionTokens:40,loadMs:2000,totalMs:9000});
  });
  it("serializes concurrent calls so one board runs one inference",async()=>{
    let live=0,peak=0;
    const {impl}=fakeFetch(async()=>{live++;peak=Math.max(peak,live);await Promise.resolve();live--;return reply("ok")});
    const model=new OllamaReasoningModel({fetch:impl});
    await Promise.all([model.complete(PROSE_PROMPT,{}),model.complete(PROSE_PROMPT,{}),model.complete(PROSE_PROMPT,{})]);
    expect(peak).toBe(1);
  });
  it("keeps serving after a failed call in the queue",async()=>{
    let n=0;
    const {impl}=fakeFetch(()=>{ if(n++===0) throw new TypeError("fetch failed"); return reply("second") });
    const model=new OllamaReasoningModel({fetch:impl});
    const first=model.complete(PROSE_PROMPT,{}).catch(()=>"failed");
    expect(await first).toBe("failed");
    expect(await model.complete(PROSE_PROMPT,{})).toBe("second");
  });
});

describe("operational errors",()=>{
  it("explains an unreachable server",async()=>{
    const {impl}=fakeFetch(()=>{throw new TypeError("fetch failed")});
    await expect(new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).rejects.toThrow(/Cannot reach Ollama at http:\/\/127\.0\.0\.1:11434.*ollama serve/s);
  });
  it("explains a model that was never pulled",async()=>{
    const {impl}=fakeFetch(new Response(JSON.stringify({error:"model 'qwen3:4b' not found"}),{status:404}));
    await expect(new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).rejects.toThrow(/ollama pull/);
  });
  it("explains a timeout in terms of board speed",async()=>{
    const {impl}=fakeFetch(()=>{const error=new Error("timed out");error.name="TimeoutError";throw error});
    await expect(new OllamaReasoningModel({fetch:impl,timeoutMs:1000}).complete(PROSE_PROMPT,{})).rejects.toThrow(/did not answer within 1000ms/);
  });
  it("surfaces an output limit instead of a parse error",async()=>{
    const {impl}=fakeFetch(reply('{"objective":"tr',{done_reason:"length"}));
    await expect(new OllamaReasoningModel({fetch:impl,maxAttempts:1}).complete(JSON_PROMPT,{})).rejects.toThrow(/output limit/);
  });
  it("never puts credentials in an error message",async()=>{
    const {impl}=fakeFetch(new Response("boom",{status:500}));
    const model=new OllamaReasoningModel({fetch:impl,headers:{authorization:"Bearer super-secret"}});
    await expect(model.complete(PROSE_PROMPT,{})).rejects.toThrow(/failed with 500/);
    await model.complete(PROSE_PROMPT,{}).catch((error:Error)=>expect(error.message).not.toContain("super-secret"));
  });
});

describe("operations helpers",()=>{
  it("lists locally pulled models",async()=>{
    const {impl,calls}=fakeFetch(new Response(JSON.stringify({models:[{name:"llama3.2:3b"},{name:"qwen3:4b"}]}),{status:200}));
    expect(await new OllamaReasoningModel({fetch:impl}).models()).toEqual(["llama3.2:3b","qwen3:4b"]);
    expect(calls[0]!.init.method).toBe("GET");
  });
  it("preloads a model without generating tokens",async()=>{
    const {impl,calls}=fakeFetch(reply(""));
    await new OllamaReasoningModel({fetch:impl}).warmup("qwen3:4b");
    expect(calls[0]!.body).toMatchObject({model:"qwen3:4b",messages:[],keep_alive:"30m"});
  });
  it("builds from the environment without reading real process env",()=>{
    expect(ollamaFromEnv({OLLAMA_BASE_URL:"http://pi:11434",LLM_MODEL:"qwen3:4b",OLLAMA_NUM_CTX:"2048"})).toBeInstanceOf(OllamaReasoningModel);
  });
});

describe("wired into the runtime",()=>{
  it("drives AgentRuntime.deliberate from a fenced local reply",async()=>{
    const proposal={objective:"Inspect current evidence",rationale:"trigger",expectedOutcome:"clarity",requestedActions:[],stopConditions:["done"],confidence:.8};
    const {impl,calls}=fakeFetch(reply("```json\n"+JSON.stringify(proposal)+"\n```"));
    const runtime=new AgentRuntime(new OllamaReasoningModel({fetch:impl}),store);
    const context={companyId:"c",generatedAt:"now",constitution:[],strategy:{},organization:{},operations:{},finance:{},customers:{},product:{},risks:{},recentEvents:[],decisions:[],openQuestions:[]};
    const result=await runtime.deliberate(APPROVED_AGENTS[0]!,context,{type:"metric.changed"});
    expect(result.objective).toContain("evidence");
    expect(calls[0]!.body.format).toBe("json");
  });
});
