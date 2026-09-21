import type { ModelMessage, ReasoningModel } from "./domain.js";

export type OllamaConfig = {
  baseUrl?:string; model?:string; timeoutMs?:number; keepAlive?:string|number; numCtx?:number; numPredict?:number;
  temperature?:number; think?:boolean; jsonMode?:"auto"|"always"|"never"; maxAttempts?:number; serialize?:boolean;
  headers?:Record<string,string>; fetch?:typeof fetch;
};
export type OllamaChatStats = {model:string; promptTokens:number; completionTokens:number; loadMs:number; totalMs:number};
type ChatResponse = {message?:{content?:string; thinking?:string}; error?:string; done_reason?:string; prompt_eval_count?:number; eval_count?:number; load_duration?:number; total_duration?:number};

const stripThinking=(text:string):string=>{
  const end=text.lastIndexOf("</think>"); if(end>=0) return text.slice(end+"</think>".length);
  return /^\s*<think>/i.test(text)?"":text;
};
const stripFences=(text:string):string=>{
  const fenced=/^\s*```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text); return fenced?fenced[1]!:text;
};
const sliceBalanced=(text:string):string|null=>{
  for(let i=0;i<text.length;i++){
    const open=text[i]; if(open!=="{"&&open!=="[") continue;
    const close=open==="{"?"}":"]"; let depth=0,inString=false,escaped=false;
    for(let j=i;j<text.length;j++){
      const ch=text[j]!;
      if(inString){ if(escaped)escaped=false; else if(ch==="\\")escaped=true; else if(ch==="\"")inString=false; continue }
      if(ch==="\""){inString=true;continue}
      if(ch===open)depth++; else if(ch===close&&--depth===0) return text.slice(i,j+1);
    }
  }
  return null;
};
export const recoverJson=(raw:string):unknown=>{
  const candidates=[raw,stripFences(raw)]; const sliced=sliceBalanced(stripFences(raw)); if(sliced)candidates.push(sliced);
  let failure="empty model reply";
  for(const candidate of candidates){ const trimmed=candidate.trim(); if(!trimmed)continue; try{return JSON.parse(trimmed)}catch(error){failure=(error as Error).message} }
  throw new Error(failure);
};
const isZodSchema=(schema:unknown):schema is {safeParse:(value:unknown)=>{success:boolean; error?:{message:string}}}=>
  typeof schema==="object"&&schema!==null&&typeof (schema as {safeParse?:unknown}).safeParse==="function";
const isJsonSchema=(schema:unknown):schema is Record<string,unknown>=>
  typeof schema==="object"&&schema!==null&&!Array.isArray(schema)&&!isZodSchema(schema)&&("type" in schema||"properties" in schema||"$schema" in schema);

export class OllamaReasoningModel implements ReasoningModel {
  private readonly baseUrl:string; private readonly defaultModel:string; private readonly timeoutMs:number;
  private readonly keepAlive:string|number; private readonly numCtx:number; private readonly numPredict:number|undefined;
  private readonly temperature:number; private readonly think:boolean|undefined; private readonly jsonMode:"auto"|"always"|"never";
  private readonly maxAttempts:number; private readonly serialize:boolean; private readonly headers:Record<string,string>;
  private readonly call:typeof fetch; private queue:Promise<unknown>=Promise.resolve(); private last:OllamaChatStats|null=null;
  constructor(config:OllamaConfig={}){
    this.baseUrl=(config.baseUrl??"http://127.0.0.1:11434").replace(/\/+$/,"");
    this.defaultModel=config.model??"llama3.2:3b";
    this.timeoutMs=config.timeoutMs??600_000;
    this.keepAlive=config.keepAlive??"30m";
    this.numCtx=config.numCtx??4096;
    this.numPredict=config.numPredict;
    this.temperature=config.temperature??0.2;
    this.think=config.think;
    this.jsonMode=config.jsonMode??"auto";
    this.maxAttempts=Math.max(1,config.maxAttempts??2);
    this.serialize=config.serialize??true;
    this.headers={...config.headers};
    const injected=config.fetch; this.call=injected?((input,init)=>injected(input,init)):((input,init)=>fetch(input,init));
  }
  lastStats(){return this.last}
  async complete(messages:ModelMessage[], options:{model?:string; temperature?:number; responseSchema?:unknown}={}):Promise<string>{
    return this.enqueue(async()=>{
      const model=options.model??this.defaultModel;
      const wantsJson=this.jsonMode==="always"||(this.jsonMode!=="never"&&(options.responseSchema!==undefined||messages.some(m=>m.role==="system"&&/\bjson\b/i.test(m.content))));
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
  async warmup(model=this.defaultModel):Promise<void>{ await this.request("/api/chat",{model,messages:[],stream:false,keep_alive:this.keepAlive}) }
  async models():Promise<string[]>{
    const listed=await this.request<{models?:Array<{name?:string}>}>("/api/tags");
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
    if(payload.done_reason==="length") throw new Error(`Ollama model ${model} hit the output limit before finishing; raise numPredict or shorten the prompt`);
    return payload.message?.content??"";
  }
  private async request<T>(path:string,body?:unknown):Promise<T>{
    let response:Response;
    try{
      response=await this.call(`${this.baseUrl}${path}`,{
        method:body===undefined?"GET":"POST",
        headers:{...(body===undefined?{}:{"content-type":"application/json"}),...this.headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal:AbortSignal.timeout(this.timeoutMs)
      });
    }catch(error){
      const name=(error as Error).name;
      if(name==="TimeoutError"||name==="AbortError") throw new Error(`Ollama at ${this.baseUrl} did not answer within ${this.timeoutMs}ms; small boards need a longer timeoutMs or a smaller model`);
      throw new Error(`Cannot reach Ollama at ${this.baseUrl}: ${(error as Error).message}. Start it with: ollama serve`);
    }
    const text=await response.text();
    if(!response.ok){
      const detail=(()=>{try{return String((JSON.parse(text) as {error?:unknown}).error??text)}catch{return text}})().slice(0,500);
      if(response.status===404&&/model/i.test(detail)) throw new Error(`Ollama has not pulled that model: ${detail}. Run: ollama pull <model>`);
      throw new Error(`Ollama request to ${path} failed with ${response.status}: ${detail}`);
    }
    try{ return JSON.parse(text) as T }catch{ throw new Error(`Ollama returned a non-JSON response from ${path}`) }
  }
}
export const ollamaFromEnv=(env:Record<string,string|undefined>=process.env):OllamaReasoningModel=>new OllamaReasoningModel({
  baseUrl:env.OLLAMA_BASE_URL, model:env.LLM_MODEL,
  ...(env.OLLAMA_TIMEOUT_MS?{timeoutMs:Number(env.OLLAMA_TIMEOUT_MS)}:{}),
  ...(env.OLLAMA_NUM_CTX?{numCtx:Number(env.OLLAMA_NUM_CTX)}:{}),
  ...(env.OLLAMA_KEEP_ALIVE?{keepAlive:env.OLLAMA_KEEP_ALIVE}:{}),
  ...(env.LLM_API_KEY?{headers:{authorization:`Bearer ${env.LLM_API_KEY}`}}:{})
});
