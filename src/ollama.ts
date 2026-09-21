import type { ModelMessage, ReasoningModel } from "./domain.js";

export type OllamaConfig = {
  baseUrl?:string; model?:string; timeoutMs?:number; keepAlive?:string|number; numCtx?:number; numPredict?:number;
  temperature?:number; think?:boolean; jsonMode?:"auto"|"always"|"never"; maxAttempts?:number; serialize?:boolean;
  headers?:Record<string,string>; fetch?:typeof fetch;
};
export type OllamaChatStats = {model:string; promptTokens:number; completionTokens:number; loadMs:number; totalMs:number};
type ChatResponse = {message?:{content?:string; thinking?:string}; error?:string; done_reason?:string; prompt_eval_count?:number; eval_count?:number; load_duration?:number; total_duration?:number};

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
export const recoverJson=(raw:string):unknown=>{
  const text=stripFences(raw).trim();
  if(!text) throw new Error("model returned an empty reply");
  if(text.startsWith("{")||text.startsWith("[")){
    try{ const value=JSON.parse(text); if(isDocument(value)) return value }
    catch(error){ throw new Error(`reply began as JSON but did not parse, so it is malformed or truncated: ${(error as Error).message}`) }
    throw new Error("reply parsed to a scalar rather than a JSON object or array");
  }
  const parsed=balancedRegions(text).map(region=>{try{return {value:JSON.parse(region) as unknown,length:region.length}}catch{return null}})
    .filter((candidate):candidate is {value:unknown;length:number}=>candidate!==null&&isDocument(candidate.value));
  if(!parsed.length) throw new Error("no JSON object or array could be recovered from the reply");
  return parsed.reduce((best,candidate)=>candidate.length>=best.length?candidate:best).value;
};
const positive=(value:number|undefined,fallback:number):number=>typeof value==="number"&&Number.isFinite(value)&&value>0?value:fallback;
const JSON_DIRECTIVE=/\breturn\b[^.]{0,40}\bjson\b/i;
const isZodSchema=(schema:unknown):schema is {safeParse:(value:unknown)=>{success:boolean; error?:{message:string}}}=>
  typeof schema==="object"&&schema!==null&&typeof (schema as {safeParse?:unknown}).safeParse==="function";
const isJsonSchema=(schema:unknown):schema is Record<string,unknown>=>
  typeof schema==="object"&&schema!==null&&!Array.isArray(schema)&&!isZodSchema(schema)&&("type" in schema||"properties" in schema||"$schema" in schema);

class OllamaHttpError extends Error {}
export class OllamaReasoningModel implements ReasoningModel {
  private readonly baseUrl:string; private readonly defaultModel:string; private readonly timeoutMs:number;
  private readonly keepAlive:string|number; private readonly numCtx:number; private readonly numPredict:number|undefined;
  private readonly temperature:number; private readonly think:boolean|undefined; private readonly jsonMode:"auto"|"always"|"never";
  private readonly maxAttempts:number; private readonly serialize:boolean; private readonly headers:Record<string,string>;
  private readonly call:typeof fetch; private queue:Promise<unknown>=Promise.resolve(); private last:OllamaChatStats|null=null;
  constructor(config:OllamaConfig={}){
    this.baseUrl=(config.baseUrl??"http://127.0.0.1:11434").replace(/\/+$/,"");
    this.defaultModel=config.model??"llama3.2:3b";
    this.timeoutMs=positive(config.timeoutMs,600_000);
    this.keepAlive=config.keepAlive??"30m";
    this.numCtx=positive(config.numCtx,4096);
    this.numPredict=typeof config.numPredict==="number"&&Number.isFinite(config.numPredict)?config.numPredict:undefined;
    this.temperature=config.temperature??0.2;
    this.think=config.think;
    this.jsonMode=config.jsonMode??"auto";
    this.maxAttempts=Math.floor(positive(config.maxAttempts,2));
    this.serialize=config.serialize??true;
    this.headers={...config.headers};
    const injected=config.fetch; this.call=injected?((input,init)=>injected(input,init)):((input,init)=>fetch(input,init));
  }
  lastStats(){return this.last}
  async complete(messages:ModelMessage[], options:{model?:string; temperature?:number; responseSchema?:unknown}={}):Promise<string>{
    return this.enqueue(async()=>{
      const model=options.model??this.defaultModel; this.last=null;
      const wantsJson=this.jsonMode==="always"||(this.jsonMode!=="never"&&(options.responseSchema!==undefined||messages.some(m=>m.role==="system"&&JSON_DIRECTIVE.test(m.content))));
      const format=wantsJson?(isJsonSchema(options.responseSchema)?options.responseSchema:"json"):undefined;
      const turns=messages.map(m=>({role:m.role,content:m.content}));
      let failure="";
      for(let attempt=0;attempt<this.maxAttempts;attempt++){
        const temperature=attempt===0?(options.temperature??this.temperature):0;
        const reply=await this.chat(model,turns,format,temperature);
        const text=stripThinking(reply).trim();
        if(!wantsJson){ if(text) return text; failure="model returned an empty reply" }
        else{
          try{
            const value=recoverJson(text);
            if(isZodSchema(options.responseSchema)){
              const checked=options.responseSchema.safeParse(value);
              if(!checked.success) throw new Error(checked.error?.message??"response did not match the supplied schema");
            }
            return JSON.stringify(value);
          }catch(error){ failure=(error as Error).message }
        }
        turns.push({role:"assistant",content:reply.slice(0,2000)},{role:"user",content:`That reply was rejected: ${failure}. Reply with ${wantsJson?"one valid JSON value and nothing else — no prose, no markdown fences":"the requested content"}.`});
      }
      throw new Error(`Ollama model ${model} did not return a usable reply after ${this.maxAttempts} attempt(s): ${failure}`);
    });
  }
  async warmup(model=this.defaultModel):Promise<void>{
    await this.enqueue(()=>this.request("/api/chat",{model,messages:[],stream:false,keep_alive:this.keepAlive,options:{num_ctx:this.numCtx}}));
  }
  async models():Promise<string[]>{
    const listed=await this.enqueue(()=>this.request<{models?:Array<{name?:string}>}>("/api/tags"));
    return (listed.models??[]).map(entry=>entry.name??"").filter(Boolean);
  }
  private enqueue<T>(task:()=>Promise<T>):Promise<T>{
    if(!this.serialize) return task();
    const next=this.queue.then(task,task); this.queue=next.then(()=>{},()=>{}); return next;
  }
  private async chat(model:string,messages:Array<{role:string;content:string}>,format:unknown,temperature:number):Promise<string>{
    const body:Record<string,unknown>={model,messages,stream:false,keep_alive:this.keepAlive,options:{temperature,num_ctx:this.numCtx,...(this.numPredict===undefined?{}:{num_predict:this.numPredict})}};
    if(format!==undefined)body.format=format;
    if(this.think!==undefined)body.think=this.think;
    const payload=await this.request<ChatResponse>("/api/chat",body);
    if(payload.error) throw new Error(`Ollama model ${model} reported an error: ${payload.error}`);
    this.last={model,promptTokens:payload.prompt_eval_count??0,completionTokens:payload.eval_count??0,loadMs:Math.round((payload.load_duration??0)/1e6),totalMs:Math.round((payload.total_duration??0)/1e6)};
    if(payload.done_reason==="length") throw new Error(`Ollama model ${model} stopped at its output limit before finishing; shorten the prompt, raise numCtx above ${this.numCtx}, or raise numPredict if it is set`);
    return payload.message?.content??"";
  }
  private async request<T>(path:string,body?:unknown):Promise<T>{
    const signal=AbortSignal.timeout(this.timeoutMs); let text:string;
    try{
      const response=await this.call(`${this.baseUrl}${path}`,{
        method:body===undefined?"GET":"POST",
        headers:{...(body===undefined?{}:{"content-type":"application/json"}),...this.headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal
      });
      text=await response.text();
      if(!response.ok){
        const detail=(()=>{try{return String((JSON.parse(text) as {error?:unknown}).error??text)}catch{return text}})().slice(0,500);
        if(response.status===404&&/model/i.test(detail)) throw new OllamaHttpError(`Ollama has not pulled that model: ${detail}. Run: ollama pull <model>`);
        throw new OllamaHttpError(`Ollama request to ${path} failed with ${response.status}: ${detail}`);
      }
    }catch(error){
      if(error instanceof OllamaHttpError) throw new Error(error.message);
      const name=(error as Error).name;
      if(name==="TimeoutError"||name==="AbortError") throw new Error(`Ollama at ${this.baseUrl} did not answer within ${this.timeoutMs}ms; small boards need a longer timeoutMs or a smaller model`);
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${(error as Error).message}. Start it with: ollama serve`);
    }
    try{ return JSON.parse(text) as T }catch{ throw new Error(`Ollama returned a non-JSON response from ${path}`) }
  }
}
export const ollamaFromEnv=(env:Record<string,string|undefined>=process.env,overrides:OllamaConfig={}):OllamaReasoningModel=>new OllamaReasoningModel({
  baseUrl:env.OLLAMA_BASE_URL, model:env.LLM_MODEL,
  ...(env.OLLAMA_TIMEOUT_MS?{timeoutMs:Number(env.OLLAMA_TIMEOUT_MS)}:{}),
  ...(env.OLLAMA_NUM_CTX?{numCtx:Number(env.OLLAMA_NUM_CTX)}:{}),
  ...(env.OLLAMA_KEEP_ALIVE?{keepAlive:/^-?\d+$/.test(env.OLLAMA_KEEP_ALIVE)?Number(env.OLLAMA_KEEP_ALIVE):env.OLLAMA_KEEP_ALIVE}:{}),
  ...(env.LLM_API_KEY?{headers:{authorization:`Bearer ${env.LLM_API_KEY}`}}:{}),
  ...overrides
});
