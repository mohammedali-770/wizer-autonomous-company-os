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

The demo seeds a small fictional company, builds the Global Company Context, has the CEO generate a work proposal from a metric that moved, runs it through the authority engine, convenes a three-seat meeting, writes and recalls a memory, and prints the audit trail. Point it at a board on your network with `OLLAMA_BASE_URL=http://raspberrypi.local:11434`, choose a model with `LLM_MODEL`, and change the table size with `WIZER_SEATS`.

Everything it did is in `.wizer/company.json`. That file is the point: the proposal, the meeting turns, the synthesis and the memory are all evidence you can read, which is easier to reason about than a database when you are learning what the system does.

Two things the run teaches faster than reading the code:

- **Seats are expensive.** Each participant in `ExecutiveMeetingRoom.convene` reads the whole accumulating transcript, so cost grows with the square of the table. Nine executives on a single board is tens of minutes per meeting. Start at three.
- **Small models fail at shape before they fail at judgement.** A 1B model often cannot hold the `WorkProposal` structure at all. At 3B the structure survives and the reasoning is thin. Watch `lastStats()` in the demo output to learn what your own hardware actually does, rather than trusting anyone's benchmark.

`LocalStore` is for development and learning only. It has no tenant isolation, no row level security, no concurrent-writer safety and no encryption, and it keeps the whole company in memory and rewrites the file on every append. The Supabase schema in `supabase/migrations` is the production path; see [docs/SECURITY.md](docs/SECURITY.md).

## Safety and operating model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONSTITUTION.md](docs/CONSTITUTION.md), and [docs/SECURITY.md](docs/SECURITY.md). This repository is a production-quality foundation, not a claim that an unattended company should control funds, contracts, employment, or production deletion without configured human approval.

## License

Apache-2.0.
