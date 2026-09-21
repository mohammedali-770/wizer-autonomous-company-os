import type { ModelMessage, ReasoningModel } from "./domain.js";

export type OllamaConfig = {
  baseUrl?:string; model?:string; timeoutMs?:number; keepAlive?:string|number; numCtx?:number; numPredict?:number;
  temperature?:number; think?:boolean; jsonMode?:"auto"|"always"|"never"; contextOverflow?:"error"|"shift";
  maxAttempts?:number; serialize?:boolean; headers?:Record<string,string>; dispatcher?:unknown; fetch?:typeof fetch;
};
export type OllamaChatStats = {model:string; promptTokens:number; completionTokens:number; loadMs:number; promptEvalMs:number; evalMs:number; totalMs:number; doneReason:string};
type ChatResponse = {message?:{content?:string; thinking?:string}; error?:string; done_reason?:string; prompt_eval_count?:number; eval_count?:number; load_duration?:number; prompt_eval_duration?:number; eval_duration?:number; total_duration?:number};

const positive=(value:number|undefined,fallback:number):number=>typeof value==="number"&&Number.isFinite(value)&&value>0?value:fallback;
const ms=(nanoseconds:number|undefined):number=>Math.round((nanoseconds??0)/1e6);
const JSON_DIRECTIVE=/\breturn\b[^.]{0,40}\bjson\b/i;
const stripThinking=(text:string):string=>{
  if(!/<think>/i.test(text)) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi,"").replace(/<think>[\s\S]*$/i,"");
};
const stripFences=(text:string):string=>{
  const fenced=/^\s*```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text); return fenced?fenced[1]!:text;
};
const balancedRegions=(text:string):string[]=>{
  const found:string[]=[];
  for(let i=0;i<text.length;i++){
    const open=text[i]; if(open!=="{"&&open!=="[") continue;
    const close=open==="{"?"}":"]"; let depth=0,inString=false,escaped=false;
    for(let j=i;j<text.length;j++){
      const ch=text[j]!;
      if(inString){ if(escaped)escaped=false; else if(ch==="\\")escaped=true; else if(ch==="\"")inString=false; continue }
      if(ch==="\""){inString=true;continue}
      if(ch===open)depth++; else if(ch===close&&--depth===0){ found.push(text.slice(i,j+1)); i=j; break }
    }
  }
  return found;
};
const isDocument=(value:unknown):boolean=>typeof value==="object"&&value!==null;
export const recoverJson=(raw:string,accept?:(value:unknown)=>string|null):unknown=>{
  const text=stripFences(raw).trim();
  if(!text) throw new Error("model returned an empty reply");
  if(text.startsWith("{")||text.startsWith("[")){
    let value:unknown;
    try{ value=JSON.parse(text) }
    catch(error){ throw new Error(`reply began as JSON but did not parse, so it is malformed or truncated: ${(error as Error).message}`) }
    if(!isDocument(value)) throw new Error("reply parsed to a scalar rather than a JSON object or array");
    const rejected=accept?accept(value):null; if(rejected) throw new Error(rejected);
    return value;
  }
  let rejection="";
  const parsed=balancedRegions(text).map(region=>{try{return {value:JSON.parse(region) as unknown,length:region.length}}catch{return null}})
    .filter((candidate):candidate is {value:unknown;length:number}=>candidate!==null&&isDocument(candidate.value))
    .filter(candidate=>{ const rejected=accept?accept(candidate.value):null; if(rejected)rejection=rejected; return !rejected });
  if(!parsed.length) throw new Error(rejection||"no JSON object or array could be recovered from the reply");
  return parsed.reduce((best,candidate)=>candidate.length>=best.length?candidate:best).value;
};
const isZodSchema=(schema:unknown):schema is {safeParse:(value:unknown)=>{success:boolean; error?:{message:string}}}=>
  typeof schema==="object"&&schema!==null&&typeof (schema as {safeParse?:unknown}).safeParse==="function";
const isJsonSchema=(schema:unknown):schema is Record<string,unknown>=>
  typeof schema==="object"&&schema!==null&&!Array.isArray(schema)&&!isZodSchema(schema)&&("type" in schema||"properties" in schema||"$schema" in schema);
const forwardableSchema=(schema:unknown):Record<string,unknown>|null=>{
  if(!isJsonSchema(schema)) return null;
  const text=JSON.stringify(schema);
  return text.length>8000||text.includes("\"$ref\"")?null:schema;
};
const normalizeHost=(raw:string):string=>{
  try{
    const explicit=/^https?:\/\//i.test(raw); const url=new URL(explicit?raw:`http://${raw}`);
    if(url.hostname==="0.0.0.0"||url.hostname==="::"||url.hostname==="[::]")url.hostname="127.0.0.1";
    if(!url.port&&!explicit)url.port="11434";
    return url.origin;
  }catch{ return raw }
};
class OllamaHttpError extends Error {}

export class OllamaReasoningModel implements ReasoningModel {
  private readonly baseUrl:string; private readonly defaultModel:string; private readonly timeoutMs:number;
  private readonly keepAlive:string|number; private readonly numCtx:number; private readonly numPredict:number;
  private readonly temperature:number; private readonly think:boolean|undefined; private readonly jsonMode:"auto"|"always"|"never";
  private readonly shift:boolean; private readonly maxAttempts:number; private readonly serialize:boolean;
  private readonly headers:Record<string,string>; private readonly dispatcher:unknown; private readonly call:typeof fetch;
  private queue:Promise<unknown>=Promise.resolve(); private last:OllamaChatStats|null=null;
  constructor(config:OllamaConfig={}){
    this.baseUrl=(config.baseUrl??"http://127.0.0.1:11434").replace(/\/+$/,"");
    this.defaultModel=config.model??"llama3.2:3b";
    this.timeoutMs=positive(config.timeoutMs,600_000);
    this.keepAlive=config.keepAlive??"30m";
    this.numCtx=positive(config.numCtx,4096);
    this.numPredict=positive(config.numPredict,1024);
    this.temperature=config.temperature??0.2;
    this.think=config.think;
    this.jsonMode=config.jsonMode??"auto";
    this.shift=config.contextOverflow==="shift";
    this.maxAttempts=Math.floor(positive(config.maxAttempts,2));
    this.serialize=config.serialize??true;
    this.headers={...config.headers};
    this.dispatcher=config.dispatcher;
    const injected=config.fetch; this.call=injected?((input,init)=>injected(input,init)):((input,init)=>fetch(input,init));
  }
  lastStats(){return this.last}
  async complete(messages:ModelMessage[], options:{model?:string; temperature?:number; responseSchema?:unknown}={}):Promise<string>{
    return this.enqueue(async()=>{
      this.last=null;
      const model=options.model??this.defaultModel;
      const instructed=messages.some(m=>m.role==="system"&&JSON_DIRECTIVE.test(m.content));
      const wantsJson=this.jsonMode==="always"||(this.jsonMode!=="never"&&(options.responseSchema!==undefined||instructed));
      const forwardable=wantsJson?forwardableSchema(options.responseSchema):null;
      const format=wantsJson?(forwardable??"json"):undefined;
      const accept=isZodSchema(options.responseSchema)
        ?(value:unknown)=>{const checked=(options.responseSchema as {safeParse:(input:unknown)=>{success:boolean;error?:{message:string}}}).safeParse(value); return checked.success?null:(checked.error?.message??"reply did not match the supplied schema")}
        :undefined;
      const turns=messages.map(m=>({role:m.role,content:m.content}));
      if(wantsJson&&!instructed) turns.push({role:"user",content:`Reply with one JSON object and nothing else.${forwardable?` It must satisfy this JSON Schema: ${JSON.stringify(forwardable).slice(0,1500)}`:""}`});
      let failure=""; let budget=this.numPredict;
      for(let attempt=0;attempt<this.maxAttempts;attempt++){
        const temperature=attempt===0?(options.temperature??this.temperature):0;
        const {text:raw,doneReason}=await this.chat(model,turns,format,temperature,budget,wantsJson);
        if(doneReason==="length"){ failure=`the model stopped at its output limit before finishing (done_reason=length); shorten the prompt, raise numCtx above ${this.numCtx}, or raise numPredict above ${budget}`; budget=Math.min(budget*2,4096); continue }
        const text=stripThinking(raw).trim();
        if(!wantsJson){ if(text) return text; failure="model returned an empty reply" }
        else{
          try{ return JSON.stringify(recoverJson(text,accept)) }
          catch(error){ failure=(error as Error).message }
        }
        turns.push({role:"assistant",content:raw.slice(0,2000)},{role:"user",content:`That reply was rejected: ${failure}. Reply with ${wantsJson?"one valid JSON value and nothing else — no prose, no markdown fences":"the requested content"}.`});
      }
      throw new Error(`Ollama model ${model} did not return a usable reply after ${this.maxAttempts} attempt(s): ${failure}`);
    });
  }
  async warmup(model=this.defaultModel):Promise<void>{
    await this.enqueue(()=>this.request("/api/chat",{model,messages:[],stream:false,keep_alive:this.keepAlive,shift:this.shift,truncate:this.shift,options:{num_ctx:this.numCtx}},Math.max(this.timeoutMs,900_000)));
  }
  async models():Promise<string[]>{
    const listed=await this.enqueue(()=>this.request<{models?:Array<{name?:string}>}>("/api/tags"));
    return (listed.models??[]).map(entry=>entry.name??"").filter(Boolean);
  }
  private enqueue<T>(task:()=>Promise<T>):Promise<T>{
    if(!this.serialize) return task();
    const next=this.queue.then(task,task); this.queue=next.then(()=>{},()=>{}); return next;
  }
  private async chat(model:string,messages:Array<{role:string;content:string}>,format:unknown,temperature:number,numPredict:number,wantsJson:boolean):Promise<{text:string;doneReason:string}>{
    const body:Record<string,unknown>={model,messages,stream:false,keep_alive:this.keepAlive,shift:this.shift,truncate:this.shift,options:{temperature,num_ctx:this.numCtx,num_predict:numPredict}};
    if(format!==undefined)body.format=format;
    const think=wantsJson?false:this.think; if(think!==undefined)body.think=think;
    const payload=await this.request<ChatResponse>("/api/chat",body);
    if(payload.error) throw new Error(`Ollama model ${model} reported an error: ${payload.error}`);
    this.last={model,promptTokens:payload.prompt_eval_count??0,completionTokens:payload.eval_count??0,loadMs:ms(payload.load_duration),promptEvalMs:ms(payload.prompt_eval_duration),evalMs:ms(payload.eval_duration),totalMs:ms(payload.total_duration),doneReason:payload.done_reason??""};
    return {text:payload.message?.content??"",doneReason:payload.done_reason??""};
  }
  private async request<T>(path:string,body?:unknown,timeoutMs=this.timeoutMs):Promise<T>{
    const signal=AbortSignal.timeout(timeoutMs); let text:string;
    try{
      const response=await this.call(`${this.baseUrl}${path}`,{
        method:body===undefined?"GET":"POST",
        headers:{...(body===undefined?{}:{"content-type":"application/json"}),...this.headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal,
        redirect:"manual",
        ...(this.dispatcher===undefined?{}:{dispatcher:this.dispatcher})
      } as unknown as RequestInit);
      text=await response.text();
      if(response.status>=300&&response.status<400) throw new OllamaHttpError(`Ollama at ${this.baseUrl} answered with a ${response.status} redirect; refusing to forward the prompt or any configured header to another host`);
      if(!response.ok){
        const detail=(()=>{try{return String((JSON.parse(text) as {error?:unknown}).error??text)}catch{return text}})().slice(0,500);
        if(response.status===404&&/model/i.test(detail)) throw new OllamaHttpError(`Ollama has not pulled that model: ${detail}. Run: ollama pull <model>`);
        if(response.status===400&&/context length|too long|exceeds/i.test(detail)) throw new OllamaHttpError(`The prompt is longer than numCtx (${this.numCtx}); shorten the company context, or raise numCtx knowing it costs RAM and forces a model reload`);
        if(response.status===400&&/thinking/i.test(detail)) throw new OllamaHttpError(`That model does not support thinking: ${detail}. Leave think unset or choose a reasoning model`);
        if(response.status===403) throw new OllamaHttpError(`Ollama refused the request host; a reverse proxy in front of it must present Host: localhost:11434`);
        throw new OllamaHttpError(`Ollama request to ${path} failed with ${response.status}: ${detail}`);
      }
    }catch(error){
      if(error instanceof OllamaHttpError) throw new Error(error.message);
      const name=(error as Error).name; const code=(error as {cause?:{code?:string}}).cause?.code;
      if(name==="TimeoutError"||name==="AbortError") throw new Error(`Ollama at ${this.baseUrl} did not answer within ${timeoutMs}ms; small boards need a longer timeoutMs or a smaller model`);
      if(code==="UND_ERR_HEADERS_TIMEOUT"||code==="UND_ERR_BODY_TIMEOUT") throw new Error(`Ollama at ${this.baseUrl} exceeded Node's built-in 300s fetch timeout, which timeoutMs cannot raise; call warmup() first, or pass dispatcher: new Agent({headersTimeout,bodyTimeout}) from undici`);
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${(error as Error).message}. Start it with: ollama serve`);
    }
    try{ return JSON.parse(text) as T }catch{ throw new Error(`Ollama returned a non-JSON response from ${path}`) }
  }
}
export const ollamaFromEnv=(env:Record<string,string|undefined>=process.env,overrides:OllamaConfig={}):OllamaReasoningModel=>new OllamaReasoningModel({
  baseUrl:env.OLLAMA_BASE_URL??(env.OLLAMA_HOST?normalizeHost(env.OLLAMA_HOST):undefined), model:env.LLM_MODEL,
  ...(env.OLLAMA_TIMEOUT_MS?{timeoutMs:Number(env.OLLAMA_TIMEOUT_MS)}:{}),
  ...(env.OLLAMA_NUM_CTX?{numCtx:Number(env.OLLAMA_NUM_CTX)}:{}),
  ...(env.OLLAMA_NUM_PREDICT?{numPredict:Number(env.OLLAMA_NUM_PREDICT)}:{}),
  ...(env.OLLAMA_KEEP_ALIVE?{keepAlive:/^-?\d+$/.test(env.OLLAMA_KEEP_ALIVE)?Number(env.OLLAMA_KEEP_ALIVE):env.OLLAMA_KEEP_ALIVE}:{}),
  ...(env.LLM_API_KEY?{headers:{authorization:`Bearer ${env.LLM_API_KEY}`}}:{}),
  ...overrides
});
