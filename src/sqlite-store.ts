import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "./domain.js";
import type { CompanyEvent } from "./event-bus.js";

type Database=InstanceType<typeof import("node:sqlite").DatabaseSync>;
export type SqliteStoreOptions={leaseMs?:number};
const CONTEXT_DOMAINS=["strategy","organization","operations","finance","customers","product","risks","recent_events","decisions","open_questions"] as const;
const COLLECTIONS=new Set(["recent_events","decisions","open_questions"]);
const words=(text:string):string[]=>text.toLowerCase().match(/[a-z0-9]{3,}/g)??[];
const SCHEMA=`
create table if not exists evidence(seq integer primary key autoincrement, at text not null, operation text not null, input text not null);
create table if not exists context(domain text primary key, value text not null);
create table if not exists memory(id integer primary key autoincrement, company_id text, kind text, subject text, content text, importance real, valid_to text);
create table if not exists scheduled(id text primary key, company_id text, type text, payload text, occurred_at text not null, claimed_at text);
create table if not exists delivered(event_id text primary key, at text not null);
create table if not exists approval(id text primary key, company_id text, request text not null, status text not null default 'pending');
create table if not exists integration_key(key text primary key, fingerprint text not null, status text not null, result text, error text, reserved_at text);
create index if not exists scheduled_due on scheduled(occurred_at);
create index if not exists evidence_operation on evidence(operation);
`;

export class SqliteStore implements Store {
  private constructor(private readonly db:Database,private readonly leaseMs:number){}
  static async open(file=":memory:",options:SqliteStoreOptions={}):Promise<SqliteStore>{
    let DatabaseSync:typeof import("node:sqlite").DatabaseSync;
    try{ ({DatabaseSync}=await import("node:sqlite")) }
    catch{ throw new Error("node:sqlite is unavailable; SqliteStore needs Node 22.5 or newer, or use LocalStore") }
    let db:Database;
    try{
      if(file!==":memory:") await mkdir(dirname(file),{recursive:true});
      db=new DatabaseSync(file);
    }catch(error){ throw new Error(`Cannot open the company database at ${file}: ${(error as Error).message}`) }
    if(file!==":memory:") db.exec("pragma journal_mode = wal");
    db.exec("pragma busy_timeout = 5000");
    db.exec(SCHEMA);
    return new SqliteStore(db,Math.max(0,options.leaseMs??60_000));
  }
  close():void{ this.db.close() }
  seedContext(domains:Record<string,unknown>):void{
    const upsert=this.db.prepare("insert into context(domain,value) values(?,?) on conflict(domain) do update set value=excluded.value");
    this.tx(()=>{ for(const [domain,value] of Object.entries(domains)) upsert.run(domain,JSON.stringify(value??null)) });
  }
  schedule(...events:CompanyEvent[]):void{
    const insert=this.db.prepare("insert into scheduled(id,company_id,type,payload,occurred_at,claimed_at) values(?,?,?,?,?,null) on conflict(id) do nothing");
    this.tx(()=>{ for(const event of events) insert.run(event.id,event.companyId,event.type,JSON.stringify(event.payload??null),event.occurredAt) });
  }
  log(operation?:string){
    const rows=(operation===undefined
      ?this.db.prepare("select at,operation,input from evidence order by seq").all()
      :this.db.prepare("select at,operation,input from evidence where operation=? order by seq").all(operation)) as Array<{at:string;operation:string;input:string}>;
    return rows.map(row=>({at:row.at,operation:row.operation,input:JSON.parse(row.input) as unknown}));
  }
  async append(operation:string,input:unknown):Promise<void>{
    const at=new Date().toISOString();
    this.tx(()=>{
      this.db.prepare("insert into evidence(at,operation,input) values(?,?,?)").run(at,operation,JSON.stringify(input??null));
      this.project(operation,input,at);
    });
  }
  async query<T>(operation:string,input?:unknown):Promise<T>{
    if(operation.startsWith("context.")){
      const domain=operation.slice("context.".length);
      if(!(CONTEXT_DOMAINS as readonly string[]).includes(domain)) throw new Error(`SqliteStore has no context domain "${domain}"`);
      const row=this.db.prepare("select value from context where domain=?").get(domain) as {value:string}|undefined;
      return (row?JSON.parse(row.value):(COLLECTIONS.has(domain)?[]:null)) as T;
    }
    if(operation==="memory.recall") return this.recall(input) as T;
    if(operation==="scheduler.claim_due") return this.claimDue(input) as T;
    if(operation==="approvals.pending"){
      const {companyId}=(input??{}) as {companyId?:string};
      const rows=(companyId===undefined
        ?this.db.prepare("select request from approval where status='pending' order by rowid").all()
        :this.db.prepare("select request from approval where status='pending' and company_id=? order by rowid").all(companyId)) as Array<{request:string}>;
      return rows.map(row=>JSON.parse(row.request)) as T;
    }
    if(operation==="approvals.status"){
      const {id}=(input??{}) as {id?:string};
      const row=this.db.prepare("select status from approval where id=?").get(id??"") as {status:string}|undefined;
      return (row?.status??"unknown") as T;
    }
    if(operation==="integrations.by_key"){
      const {idempotencyKey}=(input??{}) as {idempotencyKey?:string};
      const row=this.db.prepare("select fingerprint,status,result,error from integration_key where key=?").get(idempotencyKey??"") as {fingerprint:string;status:string;result:string|null;error:string|null}|undefined;
      if(!row) return null as T;
      return {status:row.status,fingerprint:row.fingerprint,...(row.result===null?{}:{result:JSON.parse(row.result)}),...(row.error===null?{}:{error:row.error})} as T;
    }
    throw new Error(`SqliteStore does not implement the read "${operation}"`);
  }
  private claimDue(input?:unknown):CompanyEvent[]{
    const {now}=(input??{}) as {now?:string};
    const at=now??new Date().toISOString();
    const cutoff=new Date(Date.parse(at)-this.leaseMs).toISOString();
    return this.tx(()=>{
      const rows=this.db.prepare(`select id,company_id,type,payload,occurred_at from scheduled
        where occurred_at<=? and id not in (select event_id from delivered) and (claimed_at is null or claimed_at<=?)
        order by occurred_at, id`).all(at,cutoff) as Array<{id:string;company_id:string;type:string;payload:string;occurred_at:string}>;
      const mark=this.db.prepare("update scheduled set claimed_at=? where id=?");
      for(const row of rows) mark.run(at,row.id);
      return rows.map(row=>({id:row.id,companyId:row.company_id,type:row.type,payload:JSON.parse(row.payload) as unknown,occurredAt:row.occurred_at}));
    });
  }
  private recall(input?:unknown){
    const {companyId,query,kinds,limit}=(input??{}) as {companyId?:string;query?:string;kinds?:string[];limit?:number};
    const terms=words(query??"");
    const rows=this.db.prepare("select id,kind,subject,content,importance,valid_to from memory where company_id is ? or ? is null").all(companyId??null,companyId??null) as Array<{id:number;kind:string;subject:string;content:string;importance:number;valid_to:string|null}>;
    return rows
      .filter(row=>!kinds?.length||kinds.includes(row.kind))
      .map(row=>{ const hay=words(`${row.subject} ${row.content}`); const hits=terms.filter(term=>hay.includes(term)).length;
        return {hits,id:`mem-${row.id}`,kind:row.kind,content:row.content,score:terms.length?Number(((hits/terms.length)*0.8+row.importance*0.2).toFixed(4)):row.importance,...(row.valid_to===null?{}:{validTo:row.valid_to})} })
      .filter(row=>terms.length?row.hits>0:row.score>0)
      .sort((a,b)=>b.score-a.score)
      .slice(0,limit??12)
      .map(({hits:_hits,...row})=>row);
  }
  private project(operation:string,input:unknown,at:string):void{
    const value=(input??{}) as Record<string,unknown>;
    if(operation==="memory.remember"){
      this.db.prepare("insert into memory(company_id,kind,subject,content,importance,valid_to) values(?,?,?,?,?,?)")
        .run(String(value.companyId??""),String(value.kind??"semantic"),String(value.subject??""),String(value.content??""),Number(value.importance??0.5),value.validTo===undefined?null:String(value.validTo));
      return;
    }
    if(operation==="events.publish"){
      this.db.prepare("insert into delivered(event_id,at) values(?,?) on conflict(event_id) do nothing").run(String(value.id??""),at);
      return;
    }
    if(operation==="approval.requested"){
      this.db.prepare("insert into approval(id,company_id,request,status) values(?,?,?,'pending') on conflict(id) do nothing")
        .run(String(value.id??""),String(value.companyId??""),JSON.stringify(input));
      return;
    }
    if(operation==="approval.granted"||operation==="approval.rejected"){
      const request=(value.request??{}) as {id?:string};
      this.db.prepare("update approval set status=? where id=?").run(operation==="approval.granted"?"granted":"rejected",String(request.id??""));
      return;
    }
    if(operation==="integration.requested"){ this.reserve(value,at); return }
    if(operation==="integration.completed"){
      this.db.prepare("update integration_key set status='completed', result=?, error=null where key=?").run(JSON.stringify(value.result??null),String(value.idempotencyKey??""));
      return;
    }
    if(operation==="integration.failed"){
      this.db.prepare("update integration_key set status='failed', error=? where key=?").run(String(value.error??""),String(value.idempotencyKey??""));
    }
  }
  private reserve(value:Record<string,unknown>,at:string):void{
    const key=String(value.idempotencyKey??""), fingerprint=String(value.fingerprint??"");
    const existing=this.db.prepare("select status,reserved_at from integration_key where key=?").get(key) as {status:string;reserved_at:string|null}|undefined;
    if(existing?.status==="in_doubt"&&existing.reserved_at!==null&&Date.parse(existing.reserved_at)>Date.parse(at)-this.leaseMs)
      throw new Error(`Idempotency key ${key} is already reserved by another run that has not finished; refusing to execute the same effect twice`);
    if(existing) this.db.prepare("update integration_key set fingerprint=?, status='in_doubt', reserved_at=?, result=null, error=null where key=?").run(fingerprint,at,key);
    else this.db.prepare("insert into integration_key(key,fingerprint,status,reserved_at) values(?,?,'in_doubt',?)").run(key,fingerprint,at);
  }
  private tx<T>(work:()=>T):T{
    this.db.exec("begin immediate");
    try{ const result=work(); this.db.exec("commit"); return result }
    catch(error){ try{ this.db.exec("rollback") }catch{} throw error }
  }
}
