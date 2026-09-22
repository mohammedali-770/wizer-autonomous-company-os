import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "./domain.js";
import type { CompanyEvent } from "./event-bus.js";

export type MemoryRecord = {id:string; kind:string; subject:string; content:string; importance:number; validTo?:string};
export type LocalStoreState = {context:Record<string,unknown>; memories:MemoryRecord[]; scheduled:CompanyEvent[]; log:Array<{at:string; operation:string; input:unknown}>};
const CONTEXT_DOMAINS=["strategy","organization","operations","finance","customers","product","risks","recent_events","decisions","open_questions"] as const;
const COLLECTIONS=new Set(["recent_events","decisions","open_questions"]);
const words=(text:string):string[]=>text.toLowerCase().match(/[a-z0-9]{3,}/g)??[];

export class LocalStore implements Store {
  private readonly state:LocalStoreState;
  constructor(state:Partial<LocalStoreState>={},private readonly file:string|null=null){
    this.state={context:{},memories:[],scheduled:[],log:[],...state};
  }
  static async open(file:string,seed:Partial<LocalStoreState>={}):Promise<LocalStore>{
    try{ return new LocalStore(JSON.parse(await readFile(file,"utf8")) as LocalStoreState,file) }
    catch{ const store=new LocalStore(seed,file); await store.flush(); return store }
  }
  seedContext(domains:Record<string,unknown>):void{ Object.assign(this.state.context,domains) }
  schedule(...events:CompanyEvent[]):void{ this.state.scheduled.push(...events) }
  log(operation?:string){ return this.state.log.filter(entry=>operation===undefined||entry.operation===operation) }
  snapshot():LocalStoreState{ return JSON.parse(JSON.stringify(this.state)) as LocalStoreState }
  async append(operation:string,input:unknown):Promise<void>{
    this.state.log.push({at:new Date().toISOString(),operation,input});
    if(operation==="memory.remember"){
      const memory=input as {kind?:string;subject?:string;content?:string;importance?:number;validTo?:string};
      this.state.memories.push({id:`mem-${this.state.memories.length+1}`,kind:memory.kind??"semantic",subject:memory.subject??"",content:memory.content??"",importance:memory.importance??0.5,...(memory.validTo?{validTo:memory.validTo}:{})});
    }
    await this.flush();
  }
  async query<T>(operation:string,input?:unknown):Promise<T>{
    if(operation.startsWith("context.")){
      const domain=operation.slice("context.".length);
      if(!(CONTEXT_DOMAINS as readonly string[]).includes(domain)) throw new Error(`LocalStore has no context domain "${domain}"`);
      return (this.state.context[domain]??(COLLECTIONS.has(domain)?[]:null)) as T;
    }
    if(operation==="memory.recall"){
      const {query,kinds,limit}=(input??{}) as {query?:string;kinds?:string[];limit?:number};
      const terms=words(query??"");
      const scored=this.state.memories
        .filter(memory=>!kinds?.length||kinds.includes(memory.kind))
        .map(memory=>{ const hay=words(`${memory.subject} ${memory.content}`); const hits=terms.filter(term=>hay.includes(term)).length;
          return {hits,id:memory.id,kind:memory.kind,content:memory.content,score:terms.length?Number(((hits/terms.length)*0.8+memory.importance*0.2).toFixed(4)):memory.importance,...(memory.validTo?{validTo:memory.validTo}:{})} })
        .filter(memory=>terms.length?memory.hits>0:memory.score>0)
        .sort((a,b)=>b.score-a.score)
        .map(({hits:_hits,...memory})=>memory);
      return scored.slice(0,limit??12) as T;
    }
    if(operation==="scheduler.claim_due"){
      const {now}=(input??{}) as {now?:string};
      const cutoff=now??new Date().toISOString();
      const due=this.state.scheduled.filter(event=>event.occurredAt<=cutoff);
      this.state.scheduled=this.state.scheduled.filter(event=>event.occurredAt>cutoff);
      if(due.length) await this.flush();
      return due as T;
    }
    throw new Error(`LocalStore does not implement the read "${operation}"`);
  }
  private async flush():Promise<void>{
    if(!this.file) return;
    await mkdir(dirname(this.file),{recursive:true});
    await writeFile(this.file,JSON.stringify(this.state,null,2));
  }
}
