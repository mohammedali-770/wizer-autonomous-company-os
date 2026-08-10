export type WorkSignal={fingerprint:string;goalId:string;progress:number;cost:number;at:number};
export class ConvergenceMonitor {
  constructor(private readonly repeatLimit=3,private readonly stagnantLimit=3,private readonly costLimit=100){}
  assess(history:WorkSignal[]):{continue:boolean;reason:string}{
    if(!history.length)return {continue:true,reason:"No prior attempts"};
    const recent=history.slice(-this.repeatLimit); const repeated=recent.length===this.repeatLimit&&new Set(recent.map(x=>x.fingerprint)).size===1;
    if(repeated)return {continue:false,reason:"Repeated equivalent work detected"};
    const stagnant=history.slice(-this.stagnantLimit); if(stagnant.length===this.stagnantLimit&&stagnant.every((x,i,a)=>i===0||x.progress<=a[i-1]!.progress))return {continue:false,reason:"No measurable progress"};
    if(history.reduce((s,x)=>s+x.cost,0)>=this.costLimit)return {continue:false,reason:"Work cost budget exhausted"};
    return {continue:true,reason:"Work is converging"};
  }
}
