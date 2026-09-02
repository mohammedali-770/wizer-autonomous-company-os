# Wizer Autonomous Company OS

Wizer is an open, provider-neutral foundation for running an AI-native company as a governed system of autonomous agents. It is not a scripted demo: goals, proposals, meeting contributions, hiring recommendations, and work plans are generated at runtime from a shared current company context and persisted evidence.

## Included

- Global Company Context assembled across strategy, organization, operations, finance, customers, product, risk, events, decisions, and open questions.
- Named executive team: Ali (CEO), Mahdi (CTO), Maha (Growth), Sami (Operations), Jafar (Finance), Noor (People), Rana (R&D), Omar (Internal Audit), and Lina (Data & Intelligence), each with a distinct mandate and reasoning personality.
- Memory Fabric for episodic, semantic, decision, procedural, relationship, and agent memory while keeping current truth in authoritative systems.
- Runtime agent deliberation, persistent event bus, autonomous scheduler, authority checks, human approval boundaries, idempotent Integration Gateway, dynamic organization proposals, executive meetings, and anti-loop convergence controls.
- Supabase/Postgres schema with company isolation, RLS, audit history, vector memory, metrics/provenance, meetings, events, integrations, and indexes.

## Revenue playbooks

The first end-to-end business motion ships in `src/growth`: find businesses whose public listing shows no working website or app, build each a real one-page preview, and offer it to them once, honestly, behind a compliance gate and a human approval boundary. Runnable adapters live in `src/adapters` (OpenStreetMap discovery, a polite web/app-store probe, Claude, Supabase evidence and approvals, Supabase Storage or local preview hosting, Resend or dry-run delivery) with a CLI in `src/cli`:

```bash
node dist/src/cli/wizer.js campaign --query bakery --area "Manchester" --country GB --dry-run
```

See [docs/PLAYBOOK-WEBSITE-OUTREACH.md](docs/PLAYBOOK-WEBSITE-OUTREACH.md).

## Architecture

`Trigger → Global Context → Agent Deliberation → Authority Engine → Work/Event → Integration Gateway → Evidence/Memory → Convergence Monitor`

Internal Audit has independent read/finding privileges. High-risk actions require human approval. Provider secrets are referenced, never stored in public business rows or browser code.

## Start

1. Install Node.js 20+ and run `npm ci`.
2. Copy `.env.example` to `.env` and add a Supabase URL/publishable key plus server-only secret and model credentials. To run outreach, also copy `outreach.policy.example.json` to `outreach.policy.json` and fill in your legal sender identity and per-country rules.
3. Link the Supabase CLI project and apply the migrations in `supabase/migrations` in filename order.
4. Run `npm run check`.

The core deliberately exposes interfaces rather than binding Wizer to one LLM or integration vendor. Implement `ReasoningModel`, `Store`, and `IntegrationAdapter` for deployment.

## Safety and operating model

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONSTITUTION.md](docs/CONSTITUTION.md), and [docs/SECURITY.md](docs/SECURITY.md). This repository is a production-quality foundation, not a claim that an unattended company should control funds, contracts, employment, or production deletion without configured human approval.

## License

Apache-2.0.
