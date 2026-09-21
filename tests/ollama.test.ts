import {describe,expect,it,vi} from "vitest";
import {z} from "zod";
import {AgentRuntime,APPROVED_AGENTS,ExecutiveMeetingRoom,OllamaReasoningModel,OrganizationDesigner,ollamaFromEnv,recoverJson,type CompanyContext,type Store} from "../src/index.js";

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
const rejection=(promise:Promise<unknown>):Promise<Error>=>promise.then(()=>{throw new Error("expected a rejection but the call resolved")},(error:Error)=>error);
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
    await new OllamaReasoningModel({fetch:impl}).complete([{role:"system",content:"Speak freely."},{role:"user",content:"Ops asked us to return the JSON export by Friday"}],{});
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
  it("retries rather than letting a blank contribution enter a meeting transcript",async()=>{
    const {impl,calls}=fakeFetch(reply("   \n  "),reply("We should hold the launch."));
    expect(await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).toBe("We should hold the launch.");
    expect(calls).toHaveLength(2);
  });
  it("gives up on a prose call that stays blank",async()=>{
    const {impl,calls}=fakeFetch(reply("   \n  "));
    await expect(new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).rejects.toThrow(/model returned an empty reply/);
    expect(calls).toHaveLength(2);
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
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it("actually abandons a request that never answers",async()=>{
    const impl=((_input:unknown,init:{signal:AbortSignal})=>new Promise((_resolve,reject)=>{
      init.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="TimeoutError";reject(error)});
    })) as unknown as typeof fetch;
    await expect(new OllamaReasoningModel({fetch:impl,timeoutMs:50}).complete(PROSE_PROMPT,{})).rejects.toThrow(/did not answer within 50ms/);
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
  it("refuses a redirect rather than forwarding the prompt to another host",async()=>{
    const {impl}=fakeFetch(new Response("",{status:307,headers:{location:"http://elsewhere.example/api/chat"}}));
    await expect(new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).rejects.toThrow(/307 redirect; refusing to forward/);
  });
  it("asks fetch not to follow redirects at all",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect((calls[0]!.init as any).redirect).toBe("manual");
  });
  it("reports an error delivered with a 200 status instead of burning the retry budget",async()=>{
    const {impl,calls}=fakeFetch(new Response(JSON.stringify({model:"m",error:"model requires more system memory than is available"}),{status:200}));
    await expect(new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{})).rejects.toThrow(/reported an error: model requires more system memory/);
    expect(calls).toHaveLength(1);
  });
  it("never puts credentials in any error message",async()=>{
    const secret="Bearer super-secret";
    const branches:Array<[string,Response|(()=>Response)]>=[
      ["unreachable",()=>{throw new TypeError("fetch failed")}],
      ["timeout",()=>{const error=new Error("t");error.name="TimeoutError";throw error}],
      ["model missing",new Response(JSON.stringify({error:"model 'x' not found"}),{status:404})],
      ["server error",new Response("boom",{status:500})],
      ["redirect",new Response("",{status:307,headers:{location:"http://elsewhere.example"}})],
      ["non json body",new Response("<html>proxy</html>",{status:200})],
      ["reported error",new Response(JSON.stringify({error:"out of memory"}),{status:200})]
    ];
    for(const [name,response] of branches){
      const {impl}=fakeFetch(response);
      const model=new OllamaReasoningModel({fetch:impl,maxAttempts:1,headers:{authorization:secret,"x-api-key":"proxy-key-abc"}});
      const error=await rejection(model.complete(PROSE_PROMPT,{}));
      expect(error.message,name).not.toContain("super-secret");
      expect(error.message,name).not.toContain("proxy-key-abc");
    }
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
  it("puts every environment mapping on the wire",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await ollamaFromEnv({OLLAMA_BASE_URL:"http://pi:11434",LLM_MODEL:"qwen3:4b",OLLAMA_NUM_CTX:"2048",OLLAMA_NUM_PREDICT:"256",LLM_API_KEY:"k"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://pi:11434/api/chat");
    expect(calls[0]!.body.model).toBe("qwen3:4b");
    expect(calls[0]!.body.options).toMatchObject({num_ctx:2048,num_predict:256});
    expect(calls[0]!.init.headers).toMatchObject({authorization:"Bearer k"});
  });
  it("sends configured headers on every request",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl,headers:{"x-api-key":"abc"}}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.init.headers).toMatchObject({"x-api-key":"abc","content-type":"application/json"});
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

describe("recovery hardening",()=>{
  it("prefers the real answer over a stray object emitted first",()=>
    expect(recoverJson('Thinking: {"status":"ok"}\nFinal: {"objective":"real answer"}')).toEqual({objective:"real answer"}));
  it("refuses a bare scalar instead of passing null to a caller",()=>{
    expect(()=>recoverJson("null")).toThrow(/object or array/);
    expect(()=>recoverJson("42")).toThrow(/object or array/);
  });
  it("reports truncation instead of returning an inner fragment",()=>
    expect(()=>recoverJson('{"a":{"b":1}')).toThrow(/malformed or truncated/));
  it("keeps a reply that merely mentions the closing think tag",async()=>{
    const {impl}=fakeFetch(reply('{"note":"use </think> to close"}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({note:"use </think> to close"});
  });
  it("strips reasoning tags whatever their case",async()=>{
    const {impl}=fakeFetch(reply('<THINK>x</THINK>{"a":1}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({a:1});
  });
  it("retries when a reasoning tag is never closed",async()=>{
    const {impl,calls}=fakeFetch(reply("<think>planning forever"),reply('{"a":1}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({a:1});
    expect(calls).toHaveLength(2);
  });
});

describe("configuration hardening",()=>{
  it("falls back to defaults rather than skipping the request on unusable numbers",async()=>{
    const {impl,calls}=fakeFetch(reply("hi"));
    expect(await new OllamaReasoningModel({fetch:impl,maxAttempts:NaN,timeoutMs:NaN,numCtx:0}).complete(PROSE_PROMPT,{})).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.options.num_ctx).toBe(4096);
  });
  it("preloads at the same context the real calls will use",async()=>{
    const {impl,calls}=fakeFetch(reply(""));
    await new OllamaReasoningModel({fetch:impl,numCtx:8192}).warmup();
    expect(calls[0]!.body.options).toEqual({num_ctx:8192});
  });
  it("coerces a numeric keep_alive from the environment",async()=>{
    const {impl,calls}=fakeFetch(reply("hi"));
    await ollamaFromEnv({OLLAMA_KEEP_ALIVE:"-1"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.keep_alive).toBe(-1);
  });
  it("keeps a duration keep_alive as a string",async()=>{
    const {impl,calls}=fakeFetch(reply("hi"));
    await ollamaFromEnv({OLLAMA_KEEP_ALIVE:"45m"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.keep_alive).toBe("45m");
  });
  it("serializes warmup and models alongside completions",async()=>{
    let live=0,peak=0;
    const impl=(async()=>{live++;peak=Math.max(peak,live);await new Promise(resolve=>setTimeout(resolve,5));live--;return reply("ok")}) as unknown as typeof fetch;
    const model=new OllamaReasoningModel({fetch:impl});
    await Promise.all([model.complete(PROSE_PROMPT,{}),model.warmup(),model.models().catch(()=>[])]);
    expect(peak).toBe(1);
  });
  it("clears stats so a failed call cannot report the previous one",async()=>{
    const {impl}=fakeFetch(reply("ok",{prompt_eval_count:5}),new Response("boom",{status:500}));
    const model=new OllamaReasoningModel({fetch:impl,maxAttempts:1});
    await model.complete(PROSE_PROMPT,{});
    expect(model.lastStats()).not.toBeNull();
    await model.complete(PROSE_PROMPT,{}).catch(()=>{});
    expect(model.lastStats()).toBeNull();
  });
});

describe("json intent is a directive, not a keyword",()=>{
  it("leaves the meeting prose call alone when agent data mentions json",async()=>{
    const {impl,calls}=fakeFetch(reply("I disagree with the launch date."));
    const system='Speak as Lina, Data & Intelligence, using this distinct reasoning personality: {"worldview":"every metric needs JSON-schema provenance"}. Disagree honestly.';
    expect(await new OllamaReasoningModel({fetch:impl}).complete([{role:"system",content:system},{role:"user",content:"agenda"}],{})).toBe("I disagree with the launch date.");
    expect(calls[0]!.body.format).toBeUndefined();
  });
  it("still recognises every call site that parses its reply",async()=>{
    const sites=["Generate work at runtime; never use canned scenarios or answers. Return only JSON matching WorkProposal. Constitution is binding.","Synthesize this executive discussion into decisions, dissent, assumptions, owners, deadlines, and unresolved questions. Do not erase minority views. Return JSON.","You are the People function. Return JSON with action, role, mandate, evidence, alternatives, cost, successMeasures, reviewDate."];
    for(const system of sites){
      const {impl,calls}=fakeFetch(reply('{"a":1}'));
      await new OllamaReasoningModel({fetch:impl}).complete([{role:"system",content:system}],{});
      expect(calls[0]!.body.format).toBe("json");
    }
  });
});

describe("context overflow is loud by default",()=>{
  it("refuses server side prompt shifting so evidence is never silently dropped",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.shift).toBe(false);
    expect(calls[0]!.body.truncate).toBe(false);
  });
  it("puts shift and truncate at the top level where ollama reads them",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.options.shift).toBeUndefined();
  });
  it("restores the old behaviour on request",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl,contextOverflow:"shift"}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body).toMatchObject({shift:true,truncate:true});
  });
  it("warms up with the same overflow setting so the runner is not reloaded",async()=>{
    const {impl,calls}=fakeFetch(reply(""));
    await new OllamaReasoningModel({fetch:impl,contextOverflow:"shift"}).warmup();
    expect(calls[0]!.body).toMatchObject({shift:true,truncate:true});
  });
  it("explains a context length rejection in terms of numCtx",async()=>{
    const {impl}=fakeFetch(new Response(JSON.stringify({error:"input is longer than the context length"}),{status:400}));
    await expect(new OllamaReasoningModel({fetch:impl,numCtx:2048}).complete(PROSE_PROMPT,{})).rejects.toThrow(/longer than numCtx \(2048\)/);
  });
});

describe("generation budget",()=>{
  it("always sends a finite num_predict rather than inheriting ollama's ten times context budget",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.options.num_predict).toBe(1024);
  });
  it("doubles the budget and retries rather than scolding a model that was merely interrupted",async()=>{
    const {impl,calls}=fakeFetch(reply('{"objective":"tr',{done_reason:"length"}),reply('{"objective":"ship"}'));
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{}))).toEqual({objective:"ship"});
    expect(calls[1]!.body.options.num_predict).toBe(2048);
    expect(calls[1]!.body.messages).toHaveLength(2);
  });
});

describe("thinking",()=>{
  it("disables thinking on json calls because it corrupts constrained output",async()=>{
    const {impl,calls}=fakeFetch(reply('{"a":1}'));
    await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{});
    expect(calls[0]!.body.think).toBe(false);
  });
  it("leaves a configured think value alone on prose calls",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await new OllamaReasoningModel({fetch:impl,think:true}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.body.think).toBe(true);
  });
});

describe("node fetch ceiling",()=>{
  it("names the built in 300s limit that timeoutMs cannot raise",async()=>{
    const {impl}=fakeFetch(()=>{const error=new TypeError("fetch failed");(error as any).cause={code:"UND_ERR_HEADERS_TIMEOUT"};throw error});
    await expect(new OllamaReasoningModel({fetch:impl,timeoutMs:900_000}).complete(PROSE_PROMPT,{})).rejects.toThrow(/Node's built-in 300s fetch timeout.*dispatcher/s);
  });
  it("passes a dispatcher through to fetch",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    const dispatcher={marker:true};
    await new OllamaReasoningModel({fetch:impl,dispatcher}).complete(PROSE_PROMPT,{});
    expect((calls[0]!.init as any).dispatcher).toBe(dispatcher);
  });
});

describe("environment host handling",()=>{
  it("rewrites the bind address operators are told to set on the board",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await ollamaFromEnv({OLLAMA_HOST:"0.0.0.0:11434"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
  });
  it("adds the default port to a bare host",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await ollamaFromEnv({OLLAMA_HOST:"raspberrypi.local"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://raspberrypi.local:11434/api/chat");
  });
  it("keeps an explicit scheme and port",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await ollamaFromEnv({OLLAMA_HOST:"https://ollama.example:8443"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("https://ollama.example:8443/api/chat");
  });
  it("prefers an explicit base url over the host variable",async()=>{
    const {impl,calls}=fakeFetch(reply("ok"));
    await ollamaFromEnv({OLLAMA_HOST:"0.0.0.0:11434",OLLAMA_BASE_URL:"http://pi:1234"},{fetch:impl}).complete(PROSE_PROMPT,{});
    expect(calls[0]!.url).toBe("http://pi:1234/api/chat");
  });
});

describe("schema handling",()=>{
  it("instructs the model when a schema is supplied but the prompt says nothing",async()=>{
    const {impl,calls}=fakeFetch(reply('{"a":1}'));
    await new OllamaReasoningModel({fetch:impl}).complete(PROSE_PROMPT,{responseSchema:{type:"object",properties:{a:{type:"number"}}}});
    expect(calls[0]!.body.messages).toHaveLength(3);
    expect(calls[0]!.body.messages[2].content).toMatch(/one JSON object and nothing else/);
  });
  it("does not add an instruction when the prompt already carries one",async()=>{
    const {impl,calls}=fakeFetch(reply('{"a":1}'));
    await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{});
    expect(calls[0]!.body.messages).toHaveLength(2);
  });
  it("falls back to plain json mode for a schema ollama could not compile",async()=>{
    const {impl,calls}=fakeFetch(reply('{"a":1}'));
    await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{responseSchema:{type:"object",properties:{a:{$ref:"#/definitions/x"}}}});
    expect(calls[0]!.body.format).toBe("json");
  });
  it("uses a zod schema to pick the right candidate out of prose",async()=>{
    const {impl}=fakeFetch(reply('Draft: {"objective":123456789012345} Final: {"objective":"ship"}'));
    const schema=z.object({objective:z.string()});
    expect(JSON.parse(await new OllamaReasoningModel({fetch:impl}).complete(JSON_PROMPT,{responseSchema:schema}))).toEqual({objective:"ship"});
  });
  it("reports a shape mismatch differently from missing json",async()=>{
    const {impl}=fakeFetch(reply('{"objective":123}'));
    const schema=z.object({objective:z.string()});
    await expect(new OllamaReasoningModel({fetch:impl,maxAttempts:1}).complete(JSON_PROMPT,{responseSchema:schema})).rejects.toThrow(/expected string|Expected string/);
  });
});

describe("calibration stats",()=>{
  it("exposes prefill and generation timings so a board can be measured",async()=>{
    const {impl}=fakeFetch(reply("ok",{prompt_eval_count:900,eval_count:120,load_duration:3e9,prompt_eval_duration:30e9,eval_duration:45e9,total_duration:78e9,done_reason:"stop"}));
    const model=new OllamaReasoningModel({fetch:impl});
    await model.complete(PROSE_PROMPT,{});
    expect(model.lastStats()).toEqual({model:"llama3.2:3b",promptTokens:900,completionTokens:120,loadMs:3000,promptEvalMs:30000,evalMs:45000,totalMs:78000,doneReason:"stop"});
  });
});

describe("the real call sites decide json mode, not a copy of their prompts",()=>{
  const context:CompanyContext={companyId:"c",generatedAt:"now",constitution:[],strategy:{},organization:{},operations:{},finance:{},customers:{},product:{},risks:{},recentEvents:[],decisions:[],openQuestions:[]};
  it("keeps a meeting contribution in prose and constrains only the synthesis",async()=>{
    const {impl,calls}=fakeFetch(reply("Growth is being funded ahead of retention."),reply('{"decisions":["hold"],"dissent":[]}'));
    const room=new ExecutiveMeetingRoom(new OllamaReasoningModel({fetch:impl}),store);
    const result=await room.convene({topic:"Q3 allocation",context,participants:[APPROVED_AGENTS[0]!]});
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.format).toBeUndefined();
    expect(calls[0]!.body.think).toBeUndefined();
    expect(calls[1]!.body.format).toBe("json");
    expect(calls[1]!.body.think).toBe(false);
    expect(result.synthesis).toEqual({decisions:["hold"],dissent:[]});
  });
  it("constrains an organization proposal",async()=>{
    const {impl,calls}=fakeFetch(reply('```json\n{"action":"hire","role":"Support Lead"}\n```'));
    const designer=new OrganizationDesigner(new OllamaReasoningModel({fetch:impl}),store);
    expect(await designer.propose(context,{gap:"support backlog"})).toEqual({action:"hire",role:"Support Lead"});
    expect(calls[0]!.body.format).toBe("json");
  });
});
