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

`ollamaFromEnv()` builds the same object from `OLLAMA_BASE_URL`, `LLM_MODEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_NUM_CTX`, `OLLAMA_TIMEOUT_MS`, and `LLM_API_KEY`.

| Option | Default | Reason |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:11434` | Ollama's default listener; set `OLLAMA_HOST=0.0.0.0:11434` on the board to reach it over the network. |
| `model` | `llama3.2:3b` | Fits a 4 GB board and still returns structured JSON. |
| `timeoutMs` | `600000` | A cold model load plus a long context on CPU can exceed five minutes. |
| `keepAlive` | `"30m"` | Keeps the model resident so the next call does not pay the load again. |
| `numCtx` | `4096` | Context costs RAM on a board that has little; raise deliberately. |
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
- **Failures say what to do next.** An unreachable server, an unpulled model, a timeout, and an answer truncated by the output limit each raise a distinct, actionable error. Credentials never appear in an error message.

## Safety and operating model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONSTITUTION.md](docs/CONSTITUTION.md), and [docs/SECURITY.md](docs/SECURITY.md). This repository is a production-quality foundation, not a claim that an unattended company should control funds, contracts, employment, or production deletion without configured human approval.

## License

Apache-2.0.
