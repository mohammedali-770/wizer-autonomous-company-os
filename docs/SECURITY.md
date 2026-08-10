# Security

All public-schema tables have RLS. Access is tenant-scoped through authenticated membership and explicit company roles; no anonymous table access is granted. Authorization does not use user-editable metadata. RLS predicates are indexed. Integration secrets are external secret references and server-only keys must never reach clients.

Before production: configure short-lived sessions and MFA for owners, vault-backed credentials, per-provider OAuth scopes, webhook verification, outbound allowlists, rate/cost limits, backups, audit export, model prompt-injection defenses, and incident response. Run Supabase security/performance advisors after every schema change.
