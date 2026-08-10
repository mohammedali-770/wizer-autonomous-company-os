import type { Store } from "./domain.js";
export type MemoryKind="episodic"|"semantic"|"decision"|"procedural"|"relationship"|"agent";
export class MemoryFabric {
  constructor(private readonly store:Store){}
  remember(input:{companyId:string;kind:MemoryKind;subject:string;content:string;importance:number;sourceIds:string[];validFrom?:string;validTo?:string}){return this.store.append("memory.remember",input)}
  async recall(input:{companyId:string;query:string;kinds?:MemoryKind[];limit?:number}){return this.store.query<Array<{id:string;kind:MemoryKind;content:string;score:number;validTo?:string}>>("memory.recall",{...input,limit:Math.min(input.limit??12,50)})}
}
