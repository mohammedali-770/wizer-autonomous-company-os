import { AgentRuntime, APPROVED_AGENTS, ExecutiveMeetingRoom, GlobalContextBuilder, LocalStore, MemoryFabric, ollamaFromEnv } from "./index.js";

const FILE=process.env.WIZER_STORE??".wizer/company.json";
const SEATS=Number(process.env.WIZER_SEATS??3);
const COMPANY=APPROVED_AGENTS[0]!.companyId;
const line=(label:string)=>console.log(`\n${"=".repeat(64)}\n${label}\n${"=".repeat(64)}`);
const seconds=(from:number)=>`${((Date.now()-from)/1000).toFixed(1)}s`;

const store=await LocalStore.open(FILE);
store.seedContext({
  strategy:{mission:"Supply single-origin coffee to offices in Amman",goals:["Reach 40 recurring office accounts","Hold gross margin above 55%"]},
  organization:{headcount:6,openRoles:["Delivery coordinator"]},
  operations:{deliveriesPerWeek:52,onTimeRate:0.86,roasterCapacityKgPerWeek:180},
  finance:{cashJod:38000,monthlyBurnJod:9500,runwayMonths:4},
  customers:{accounts:23,churnedLastQuarter:3,topComplaint:"Late Sunday deliveries"},
  product:{skus:7,bestSeller:"Ethiopia Guji 1kg"},
  risks:[{risk:"Single roaster, no backup",severity:"high"}],
  recent_events:[{type:"delivery.late",count:9,window:"last 14 days"}],
  decisions:[{decision:"Paused wholesale discounting",at:"2026-08-02"}],
  open_questions:["Is Sunday lateness a routing problem or a capacity problem?"]
});

const model=ollamaFromEnv();
line(`Wizer local run — model ${process.env.LLM_MODEL??"llama3.2:3b"}, store ${FILE}`);
console.log("Preloading the model so the first real call does not pay the disk read...");
const warm=Date.now();
try{ await model.warmup(); console.log(`Loaded in ${seconds(warm)}`) }
catch(error){ console.error(`\n${(error as Error).message}\n`); process.exit(1) }

line("1. Global company context");
const context=await new GlobalContextBuilder(store).build(COMPANY);
console.log(`${context.constitution.length} binding clauses, 10 domains, generated ${context.generatedAt}`);

line("2. Deliberation — Ali generates work from evidence");
const runtime=new AgentRuntime(model,store);
const started=Date.now();
try{
  const proposal=await runtime.deliberate(APPROVED_AGENTS[0]!,context,{type:"metric.changed",metric:"onTimeRate",from:0.94,to:0.86});
  console.log(`objective   : ${proposal.objective}`);
  console.log(`rationale   : ${proposal.rationale}`);
  console.log(`confidence  : ${proposal.confidence}`);
  console.log(`actions     : ${proposal.requestedActions.length}`);
  for(const {action,decision} of runtime.authorize(APPROVED_AGENTS[0]!,proposal))
    console.log(`  ${action.capability} (${action.risk}) -> ${decision.allowed?"allowed":"refused"}${decision.requiresHuman?", needs a human":""}: ${decision.reason}`);
}catch(error){
  console.error(`Deliberation failed: ${(error as Error).message}`);
  console.error("A 1B model often cannot hold the WorkProposal shape. Try LLM_MODEL=qwen3:4b.");
}
const stats=model.lastStats();
if(stats) console.log(`\ntook ${seconds(started)} | prompt ${stats.promptTokens} tok in ${stats.promptEvalMs}ms (${(stats.promptTokens/Math.max(stats.promptEvalMs,1)*1000).toFixed(1)} tok/s) | wrote ${stats.completionTokens} tok in ${stats.evalMs}ms (${(stats.completionTokens/Math.max(stats.evalMs,1)*1000).toFixed(1)} tok/s)`);

line(`3. Executive meeting — ${SEATS} seats`);
console.log("Each seat reads the whole accumulating transcript, so cost grows with every seat.");
const meetingStart=Date.now();
try{
  const room=new ExecutiveMeetingRoom(model,store);
  const meeting=await room.convene({topic:"Sunday deliveries are 8 points below target",context,participants:APPROVED_AGENTS.slice(0,SEATS)});
  for(const turn of meeting.transcript as Array<{name:string;response:string}>) console.log(`\n${turn.name}: ${turn.response.slice(0,240)}`);
  console.log(`\nsynthesis: ${JSON.stringify(meeting.synthesis).slice(0,400)}`);
}catch(error){ console.error(`Meeting failed: ${(error as Error).message}`) }
console.log(`\n${SEATS} seats + synthesis took ${seconds(meetingStart)}`);

line("4. Memory");
const memory=new MemoryFabric(store);
await memory.remember({companyId:COMPANY,kind:"decision",subject:"Sunday routing",content:"Sunday lateness traced to one driver covering two zones.",importance:0.8,sourceIds:[]});
console.log(JSON.stringify(await memory.recall({companyId:COMPANY,query:"why are Sunday deliveries late"}),null,2));

line("5. Audit trail");
const counts=new Map<string,number>();
for(const entry of store.log()) counts.set(entry.operation,(counts.get(entry.operation)??0)+1);
for(const [operation,count] of [...counts].sort()) console.log(`  ${operation.padEnd(22)} ${count}`);
console.log(`\nEverything above is in ${FILE}. Open it — that file is the company's evidence.`);
