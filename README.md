# Wizer Autonomous Company OS

Wizer is an open, provider-neutral foundation for running an AI-native company as a governed system of autonomous agents. It is not a scripted demo: goals, proposals, meeting contributions, hiring recommendations, and work plans are generated at runtime from a shared current company context and persisted evidence.

## Included

- Global Company Context assembled across strategy, organization, operations, finance, customers, product, risk, events, decisions, and open questions.
- Named executive team: Ali (CEO), Mahdi (CTO), Maha (Growth), Sami (Operations), Jafar (Finance), Noor (People), Rana (R&D), Omar (Internal Audit), and Lina (Data & Intelligence), each with a distinct mandate and reasoning personality.
- Memory Fabric for episodic, semantic, decision, procedural, relationship, and agent memory while keeping current truth in authoritative systems.
- Runtime agent deliberation, persistent event bus, autonomous scheduler, authority checks, human approval boundaries, idempotent Integration Gateway, dynamic organization proposals, executive meetings, and anti-loop convergence controls.
- Supabase/Postgres schema with company isolation, RLS, audit history, vector memory, metrics/provenance, meetings, events, integrations, and indexes.

## Architecture

`Trigger → Global Context → Agent Deliberation → Authority Engine → Work/Event → Integration Gateway → Evidence/Memory → Convergence Monitor`

Internal Audit has independent read/finding privileges. High-risk actions require human approval. Provider secrets are referenced, never stored in public business rows or browser code.

## Start

1. Install Node.js 20+ and run `npm ci`.
2. Copy `.env.example` to `.env` and add a Supabase URL/publishable key plus server-only secret and model credentials.
3. Link the Supabase CLI project and apply `supabase/migrations/20260810000100_wizer_foundation.sql`.
4. Run `npm run check`.

The core deliberately exposes interfaces rather than binding Wizer to one LLM or integration vendor. Implement `ReasoningModel`, `Store`, and `IntegrationAdapter` for deployment.

## Local models (Ollama)

`OllamaReasoningModel` is a dependency-free `ReasoningModel` for an Ollama server, including one running on a Raspberry Pi on the same network. It is written for small quantized models, where the constraint is not capability but patience and JSON discipline.

```ts
import { AgentRuntime, OllamaReasoningModel } from "wizer-autonomous-company-os";

const model = new OllamaReasoningModel({ baseUrl: "http://raspberrypi.local:11434", model: "qwen3:4b" });
await model.warmup();
const runtime = new AgentRuntime(model, store);
```

`ollamaFromEnv()` builds the same object from `OLLAMA_BASE_URL` or `OLLAMA_HOST`, `LLM_MODEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, `OLLAMA_TIMEOUT_MS`, and `LLM_API_KEY`. `OLLAMA_HOST` is a bind address on the server (`0.0.0.0:11434`), which is not connectable as a client URL, so it is rewritten to `127.0.0.1` and given the default port when it carries neither.

| Option | Default | Reason |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:11434` | Ollama's default listener; set `OLLAMA_HOST=0.0.0.0:11434` on the board to reach it over the network. |
| `model` | `llama3.2:3b` | Fits a 4 GB board and still returns structured JSON. |
| `timeoutMs` | `600000` | A cold model load plus a long context on CPU can exceed five minutes. |
| `keepAlive` | `"30m"` | Keeps the model resident so the next call does not pay the load again. |
| `numCtx` | `4096` | Context costs RAM on a board that has little; raise deliberately. Changing it between calls forces a model reload, so it is never varied. |
| `numPredict` | `1024` | Never left unset: Ollama expands an absent or `-1` budget to ten times the context, which is over six hours of generation on a Pi 4. Doubles, to a ceiling of 4096, when a reply is cut off. |
| `contextOverflow` | `"error"` | See below. `"shift"` restores Ollama's default. |
| `dispatcher` | unset | An undici `Agent` for deployments that need to raise Node's own fetch ceiling. See below. |
| `temperature` | `0.2` | Structured output degrades quickly as temperature rises. |
| `jsonMode` | `"auto"` | See below. `"always"` and `"never"` override the inference. |
| `maxAttempts` | `2` | One corrective retry, because each attempt costs minutes. |
| | | Unusable numeric options fall back to these defaults rather than disabling the request. |
| `serialize` | `true` | Concurrent inference on one board causes swapping. |
| `think` | unset | Only sent when set, since models that cannot reason reject the field. |
| `headers` | `{}` | For an authenticating reverse proxy in front of Ollama. |
| `fetch` | global | Injection point for tests. |

Behaviour worth knowing:

- **JSON mode is inferred, not assumed.** `AgentRuntime.deliberate`, the meeting synthesis, and `OrganizationDesigner.propose` each `JSON.parse` the reply and each *instruct* the model to return JSON; the meeting contribution that must stay prose does not. The adapter turns on Ollama's constrained JSON decoding for exactly those calls. It matches the instruction rather than the bare word, and reads only system messages, so neither company data nor an agent's own mandate and personality text can flip a prose call into JSON mode.
- **Replies are repaired before they are returned, but never invented.** Reasoning traces (only where one actually opened, whatever its case) and markdown fences are stripped. A reply that is already a JSON document is parsed as one, and if it fails to parse it is reported as malformed or truncated rather than scavenged for an inner fragment that would be returned as a confident wrong answer. Only a reply wrapped in prose is scanned for embedded JSON, with string and escape awareness, taking the largest candidate. A scalar is refused. Anything unusable is retried at temperature zero with the failure fed back to the model.
- **A `responseSchema` is used.** A JSON Schema is forwarded to Ollama for constrained decoding; a zod schema enables JSON mode and validates the result, and a validation failure is retried like a parse failure.
- **An over-long prompt fails loudly.** Ollama's default is to discard a block from the *middle* of a prompt that exceeds the context window and answer anyway, over HTTP 200. Here that would mean a confident `WorkProposal` reasoned from mutilated evidence and written to the audit log as if sound, against the constitution's first rule. The adapter sends `shift: false` and `truncate: false`, turning that into a rejection that names `numCtx`. Set `contextOverflow: "shift"` to take the old behaviour back.
- **Thinking is disabled on JSON calls.** Reasoning and constrained decoding together corrupt the first content token, so `think` is forced off wherever the reply will be parsed, and left alone on prose calls.
- **Redirects are refused, not followed.** The documented deployment is plain HTTP across a LAN, so a compromised endpoint or anyone on-path could answer with a 307 and have Node replay the request elsewhere — carrying the whole serialised company context and every configured header, with the attacker's reply becoming the agent's work proposal before the authority engine ever sees it. The adapter sends `redirect: "manual"` and treats any 3xx as an error.
- **Failures say what to do next.** An unreachable server, an unpulled model, a timeout, a context rejection, and an answer cut off by the output limit each raise a distinct, actionable error. Credentials never appear in an error message.

### Node's own fetch ceiling

`timeoutMs` cannot raise it. Node's `fetch` aborts a request whose response headers have not arrived within 300 seconds, and with non-streaming replies the headers do not arrive until the model has finished generating. A cold 8B model on a Pi crosses that line well before the adapter's own timeout is spent, surfacing as `UND_ERR_HEADERS_TIMEOUT`.

`warmup()` and `keep_alive` take the model load out of that budget, which is enough for 3B and 4B models on a Pi 5. Past that, raise the ceiling explicitly:

```ts
import { Agent } from "undici";

const model = new OllamaReasoningModel({
  baseUrl: "http://raspberrypi.local:11434",
  dispatcher: new Agent({ headersTimeout: 1_800_000, bodyTimeout: 600_000 })
});
```

`undici` ships inside Node and is not a dependency of this package; install it only if you need to construct an `Agent`. The adapter detects this failure and names the fix rather than reporting an unreachable server.

## Running the whole company locally, for nothing

`LocalStore` is a `Store` implementation backed by one JSON file, with no dependencies and no services. Together with the Ollama adapter it makes the repository runnable on hardware you already own, with no cloud account and no API key.

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
npm ci && npm run demo
```

The demo seeds a small fictional company, queues a day of events, and then calls nothing. `AutonomousScheduler` claims each event when its hour arrives and `PersistentEventBus` routes it to whichever handler is registered for that type, so the run walks the whole documented path — trigger, context, deliberation, authority, work, integration, evidence, convergence — under its own power.

```
--- 08:00 ---
   Ali proposes: Diagnose and fix Sunday delivery lateness
      ops desk executed work.delegate (idempotency evt-1:work.delegate)
      parked decision.approve for a human: Consequential action crosses the human approval boundary
--- 10:00 ---
   Sami proposes: Diagnose and fix Sunday delivery lateness
      decision.approve (high) -> outside delegated authority
--- 13:00 ---
   convergence monitor refused to act again — Repeated equivalent work detected
```

Those three lines are the system's whole argument: the same proposal is executed, parked, or refused depending on which agent made it and what it costs, and a trigger that keeps firing eventually stops being acted on. Point it at a board on your network with `OLLAMA_BASE_URL=http://raspberrypi.local:11434`, choose a model with `LLM_MODEL`, and change the table size with `WIZER_SEATS`.

Everything it did is in `.wizer/company.json`. That file is the point: the proposal, the meeting turns, the synthesis and the memory are all evidence you can read, which is easier to reason about than a database when you are learning what the system does.

Two things the run teaches faster than reading the code:

- **Seats are expensive.** Each participant in `ExecutiveMeetingRoom.convene` reads the whole accumulating transcript, so cost grows with the square of the table. Nine executives on a single board is tens of minutes per meeting. Start at three.
- **`LocalStore` delivers at most once.** It claims an event before its handler runs, so a handler that throws forfeits the rest of that batch. `SqliteStore` does not have this limitation; either way the demo's handlers catch their own failures, and yours should too.
- **Small models fail at shape before they fail at judgement.** A 1B model often cannot hold the `WorkProposal` structure at all. At 3B the structure survives and the reasoning is thin. Watch `lastStats()` in the demo output to learn what your own hardware actually does, rather than trusting anyone's benchmark.

`LocalStore` is for development and learning only. It has no tenant isolation, no row level security, no concurrent-writer safety and no encryption, and it keeps the whole company in memory and rewrites the file on every append. The Supabase schema in `supabase/migrations` is the production path; see [docs/SECURITY.md](docs/SECURITY.md).

## The human approval boundary

`AuthorityEngine` decides that an action needs a person. `ApprovalQueue` is what happens next: it parks the request, refuses to let the company decide it, and publishes the decision back onto the event bus so the original work resumes under a name.

```ts
const approvals = new ApprovalQueue(store, { bus, agentIdentities: APPROVED_AGENTS.flatMap(a => [a.id, a.name]) });

bus.on("approval.granted", async event => {
  const { request, approvedBy } = event.payload as ApprovalOutcome;
  await gateway.execute({ provider: request.provider, operation: request.capability, payload: request.payload, idempotencyKey: request.id, approvedBy });
});
```

Three constitutional rules are enforced in code rather than left to the caller, because each corresponds to a clause that is binding on the whole system:

- **No agent may decide it.** `agentIdentities` covers the entire roster by id and by name, not merely the agent that asked, so Sami cannot approve what Ali requested. Clause nine reserves exceptional authority from every agent, not just the requesting one.
- **Every decision is signed.** An unnamed approver is refused, and the name travels from the grant through to `integration.requested` as `approvedBy`, so the trail reads `Ali asked, mohammed approved, the ops desk executed`. That is clause three's attribution requirement carried end to end.
- **A decision is final.** Granting or rejecting twice is refused, and a decided id cannot be reopened by a fresh request, so a rejection cannot be quietly retried until it succeeds. Clause nine again: audit history is not erasable.

The queue holds no state of its own. `pending` and `status` are derived from the append-only trail, so a restart recovers exactly what was outstanding, and the evidence is the record rather than a copy of it. `npm run demo` exercises the whole path, including the three refusals.

## What a Store must answer

`Store.append` accepts any operation, so evidence is open ended. Reads are not: the core asks for exactly these, and an implementation that omits one will fail at the call site rather than at startup.

| Read | Returns |
| --- | --- |
| `context.strategy` and the nine other domains | that slice of the company, or `null` |
| `memory.recall` | scored memories for a query, honouring `kinds` and `limit` |
| `scheduler.claim_due` | events at or before `now`, claimed so they are not returned twice |
| `approvals.pending` | approval requests with no decision recorded |
| `approvals.status` | `pending`, `granted`, `rejected` or `unknown` for one id |
| `integrations.by_key` | the last outcome for an idempotency key, or `null` |

`LocalStore` derives all six by folding the append-only log, which is why a restart recovers the exact outstanding state. `SqliteStore` answers them from indexed tables and takes the transactions that `scheduler.claim_due` and `integrations.by_key` need in order to be correct when more than one run is going.

## Executing an effect exactly once

`IntegrationGateway` refuses to run the same side effect twice. Before calling an adapter it reads `integrations.by_key`; a key that already completed returns the original result and records `integration.duplicate` rather than repeating the work. Concurrent calls on one key collapse into a single execution, and the record is durable, so a restarted process does not repeat what the previous one finished.

A failed attempt may be retried under the same key, because a failure is not a completed effect. A request with no recorded outcome, which is what a process killed mid-call leaves behind, is retried once its reservation has gone stale, and both requests stay visible in the trail so an auditor can see the gap. The gateway's in-process guard cannot see another process; `SqliteStore` closes that by making the reservation itself the lock, so a second run is refused rather than allowed to repeat the effect. What no store can close is the window inside a single attempt: the side effect happens outside the database, so a process killed between calling the adapter and recording the outcome leaves a fact the database never saw.

Reusing a key for different work is refused outright. Each request is fingerprinted over its provider, operation and payload, with object keys sorted so that field order cannot change the result, and a key whose fingerprint does not match its earlier use raises rather than silently returning the old result.

The payload itself is never written to the trail. Only the fingerprint is, so `integration.requested`, `integration.completed` and `integration.failed` can be read, compared and audited without exposing the customer or payment details an effect carried.

What an adapter *returns* is recorded verbatim, because the result is the evidence that the effect happened. The gateway cannot redact what it did not construct, so an adapter that echoes its own input back into its result puts the payload straight into the trail the gateway just kept it out of. Return a receipt, a reference or a status, not the request.

## A store that takes transactions

`SqliteStore` answers the same six reads as `LocalStore` over a single SQLite file, with no dependencies and no service, using the `node:sqlite` module built into Node 22.5 and newer. It is a drop-in: the demo runs against either and writes the same trail.

```bash
WIZER_DB=.wizer/company.db npm run demo
```

Two things `LocalStore` cannot do follow from having real transactions.

**A handler that throws no longer costs the rest of the batch.** Claiming and delivering are separate facts. `scheduler.claim_due` takes a short lease on the rows it hands out, and an event counts as delivered only once `events.publish` records it, so a batch interrupted half way leaves the untouched events to be claimed again while the one that failed is not retried. A lease also stops two runs claiming the same event, which the in-memory store cannot prevent at all.

**A second run cannot repeat an effect the first is still performing.** The reservation written by `integration.requested` is the lock: taking it is a transaction, so a concurrent run is refused by the database rather than by a guard that only sees its own process. A reservation whose run died becomes claimable again once the lease expires, and a refused append rolls back whole, so the trail never records a request that was turned away.

`SqliteStore.open()` imports `node:sqlite` lazily, so the package still loads on Node 20, where the class throws a clear error and `LocalStore` remains the option. CI runs the suite on both, and these tests skip where the module is absent.

## Safety and operating model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONSTITUTION.md](docs/CONSTITUTION.md), and [docs/SECURITY.md](docs/SECURITY.md). This repository is a production-quality foundation, not a claim that an unattended company should control funds, contracts, employment, or production deletion without configured human approval.

## License

Apache-2.0.
