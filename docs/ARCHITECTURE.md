# Architecture

Every agent receives a compact company-wide world state and can request deeper authoritative data. Memory supplies historical meaning; it never substitutes for live finance, customer, product, or operational truth.

The runtime reacts to scheduled and external events. An agent generates a typed proposal from its mandate, personality, constitution, trigger, and Global Company Context. The authority engine rejects undelegated actions and routes consequential work for human approval. The Integration Gateway executes approved effects with idempotency and an audit trail. Evidence becomes events, decisions, observations, and memories. The Convergence Monitor halts repeated, stagnant, or over-budget work.

Dynamic HR is proposal-driven: Noor may recommend agents or departments only from evidenced gaps, with alternatives, cost, success measures, and a review date. R&D uses bounded experiments. Internal Audit preserves independence and dissent. Data & Intelligence owns definitions, provenance, and context quality.

The meeting room is live because each participant contribution is generated against the accumulated transcript and current context. No business scenario or answer is hardcoded.

Reasoning is a port, not a dependency. `ReasoningModel` is the only surface an agent uses to think, so a hosted frontier model and a quantized model on a single board are interchangeable at the boundary. Adapters absorb the difference: the bundled Ollama adapter constrains decoding to JSON where a caller parses the reply, repairs the output small local models actually emit, serializes inference for hardware that can only run one model at a time, and fails with errors an operator can act on.
