import { COMPANY_CONSTITUTION } from "./constitution.js";
import type { CompanyContext, Store } from "./domain.js";
export class GlobalContextBuilder {
  constructor(private readonly store:Store){}
  async build(companyId:string):Promise<CompanyContext>{
    const [strategy,organization,operations,finance,customers,product,risks,recentEvents,decisions,openQuestions]=await Promise.all([
      "strategy","organization","operations","finance","customers","product","risks","recent_events","decisions","open_questions"
    ].map(k=>this.store.query<unknown>(`context.${k}`,{companyId})));
    return {companyId,generatedAt:new Date().toISOString(),constitution:[...COMPANY_CONSTITUTION],strategy,organization,operations,finance,customers,product,risks,recentEvents:recentEvents as unknown[],decisions:decisions as unknown[],openQuestions:openQuestions as unknown[]};
  }
}
