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
