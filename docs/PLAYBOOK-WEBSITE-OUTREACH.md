# Playbook: businesses without a website

The first revenue motion Wizer runs end to end. Find businesses whose public listing shows no working website or app, build them a real one-page preview, and offer it to them — once, honestly, with a way to say no.

`discover → assess presence → qualify → build preview → publish (unindexed) → compose → compliance gate → human approval → send → suppress on opt-out`

## Modules

| Module | Responsibility |
| --- | --- |
| `growth/discovery.ts` | Pulls candidates from any `BusinessDirectorySource`, normalizes them, deduplicates by name/locality/postcode/host fingerprint, and refuses records the source's terms forbid storing. |
| `growth/presence.ts` | Turns "do they have a website?" into evidence: directory field, DNS resolution, HTTP status, parked/empty content, social-only or platform-hosted hosts, app store match. Emits `gapScore` and `confidence`. |
| `growth/demo-site.ts` | Generates preview copy from verified facts only, rejects invented claims, renders non-indexable HTML with a mandatory unaffiliated-preview disclosure, publishes and takes down through the Integration Gateway. |
| `growth/compliance.ts` | The gate every message passes: suppression, jurisdiction, consent, publicly-listed contacts, frequency caps, quiet hours, daily caps, and structural message requirements. Also handles opt-out. |
| `growth/outreach.ts` | Composes short honest copy, rejects copy that implies the business asked for this, and appends the identity/source/opt-out blocks in code so the model cannot drop them. |
| `growth/pipeline.ts` | Orchestrates the run under authority, convergence, events, and memory. |

## Where the system deliberately stops

- **`outreach.send` is on the human approval boundary** in `AuthorityEngine`, alongside funds transfer and contract signing. No agent can send first-contact messages unattended, whatever the policy says.
- **Unknown jurisdiction fails closed.** A business in a country with no configured rule is never contacted.
- **Consent-required countries block unsolicited email** unless the contact carries an explicit opt-in.
- **Contacts that were not publicly listed** by the business are never used without opt-in.
- **A preview is never indexable**, always carries the disclosure naming the sender and denying affiliation, and is torn down automatically if outreach is blocked or the business opts out.
- **Invented facts are rejected before publication.** Hours, prices, founding dates, ratings, credentials, track records, and contact details that are not in the verified record fail the build. Unknowns become questions for the owner.
- **Convergence halts the campaign** when runs repeat, stop progressing, or exhaust the cost budget.

## Configuration you must supply

`OutreachPolicy` is not optional and has no safe default:

```ts
const policy: OutreachPolicy = {
  senderIdentity: {legalName: "Your Ltd", postalAddress: "…", replyToEmail: "…", websiteUrl: "https://…"},
  allowedChannels: ["email"],
  jurisdictions: {GB: {unsolicitedBusinessEmail: "opt_out_allowed", phoneRequiresRegistryCheck: true}},
  maxTouchesPerProspect: 2, minDaysBetweenTouches: 7,
  quietHours: {startHour: 20, endHour: 8}, dailySendCap: 25, requireHumanApproval: true
};
```

Confirm the `jurisdictions` map against current local law before enabling a country; the values in tests and docs are illustrative, not legal advice. Several jurisdictions (Germany, Canada, and others) require prior consent even for business-to-business email, and some require a do-not-call registry check before any call.

## Adapters to implement

- `BusinessDirectorySource` — a business directory or map API. Declare its terms honestly: several major providers forbid derived storage or cap retention, and `ProspectDiscovery` enforces what you declare.
- `WebProbe` / `AppDirectory` — DNS and HTTP probing of the single listed URL, and app store lookup. Probe politely: one root request per business, cached, rate limited, honoring `robots.txt` for anything deeper.
- Gateway providers `site_host` (`publish_preview`, `unpublish_preview`) and `outreach_channel` (`send.email`, …).
- `SuppressionList` and `ApprovalGate` — back these with `public.outreach_suppression` and your human approval queue.

## Evidence trail

Every run writes `prospect.batch_discovered`, `demo.published`, `outreach.blocked`, `outreach.approval_requested`, `outreach.sent`, `growth.pipeline_error`, and `growth.campaign_run_completed` to the event bus, appends assessments, previews, messages, and touches to the store, and records a relationship memory per business contacted. Internal Audit can reconstruct why any given business was contacted and on what evidence.

## Data retention

`prospects.retain_until` comes from the source's declared retention cap. `public.purge_expired_prospects()` soft-deletes expired records; schedule it. Opt-out suppression is stored as a hash and is never purged — it is the record of a "no".

## Running it

```bash
npm ci && npm run build
cp .env.example .env                                  # model key, Supabase, hosting, channel
cp outreach.policy.example.json outreach.policy.json  # your legal identity and per-country rules
supabase db push                                      # applies both migrations

# 1. discover, probe, build previews, queue outreach for a human
node dist/src/cli/wizer.js campaign --query bakery --area "Manchester" --country GB --limit 10

# 2. read what it wants to send, then decide
node dist/src/cli/wizer.js approvals
node dist/src/cli/wizer.js approve <approvalId> --by "your name"

# 3. deliver only what a human approved (compliance is re-checked at send time)
node dist/src/cli/wizer.js send-approved

# someone says no
node dist/src/cli/wizer.js opt-out --prospect openstreetmap:node/42 --contact hello@business.example
```

`--dry-run` swaps Supabase for in-memory evidence and prints the drafted messages instead of storing them; add `--auto-approve` (refused against a live channel) to walk the whole path including the send adapter, which writes files to `OUTREACH_DIR` rather than sending. `--query` takes an OSM tag filter (`shop=bakery`) or a plain category (`bakery`, `dentist`, `plumber`, …); `--area` takes a place name or a `south,west,north,east` bounding box.

## The adapters

| Interface | Implementation | Notes |
| --- | --- | --- |
| `BusinessDirectorySource` | `OpenStreetMapDirectory` (Overpass) | ODbL, so derived storage is permitted with attribution; the query builder only accepts a validated tag filter and a place name or bbox, so a category string can never inject Overpass QL. Public instances rate-limit — point `OVERPASS_ENDPOINT` elsewhere if needed. |
| `WebProbe` | `PoliteWebProbe` | DNS lookup, one throttled request per host, `robots.txt` honored, capped response reads, identifying user agent. Set `PROBE_USER_AGENT` to a real contact URL. |
| `AppDirectory` | `AppleAppStoreDirectory` | iTunes Search API. Google Play has no equivalent open endpoint, so `app: "none"` means "no Apple listing matched" — it is a weak signal and never qualifies a business on its own. |
| `ReasoningModel` | `AnthropicReasoningModel` | Claude with structured outputs (`output_config.format`), so preview content and outreach copy arrive schema-valid; refusals surface as errors rather than as empty pages. |
| `Store`, `SuppressionList`, `ApprovalGate` | `SupabaseStore`, `SupabaseSuppressionList`, `SupabaseApprovalGate` | Server-side secret key, so keep it off any client. In-memory equivalents exist for `--dry-run`. |
| `site_host` | `SupabaseStorageSiteHost`, `LocalDirectorySiteHost` | Both refuse to publish anything flagged indexable. Storage previews live in a public bucket at an unguessable path; serve production previews from a domain that is not your app's origin. |
| `outreach_channel` | `ResendEmailChannel`, `DryRunOutreachChannel` | Real sends carry `List-Unsubscribe` headers and a per-message idempotency key. Neither adapter will send anything but email — other channels need their own reviewed adapter. |

### What the probe can and cannot see

Presence is graded from what a server returns without JavaScript, which produces two failure modes the assessor handles explicitly:

- A **script-rendered site** returns a large HTML shell with no readable text. That is a working website; it is classified `owned` and never contacted.
- A **robots-disallowed site** proves a site exists. Also `owned`, never contacted.
- A domain that resolves but never answers is `broken` with a confidence penalty that drops it below the contact threshold — a suspicion, not evidence.

The only classifications that lead to contact are: no website listed at all, a listing pointing at a social or link-in-bio page, and a domain that resolves to a 4xx/5xx or a near-empty placeholder page.
