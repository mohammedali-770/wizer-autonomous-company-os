create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies on delete cascade,
  kind text not null,
  subject text not null,
  payload jsonb not null default '{}',
  idempotency_key text not null,
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_by text check(decided_by is null or length(btrim(decided_by)) > 0),
  decided_at timestamptz,
  note text,
  unique(company_id, idempotency_key),
  check((status = 'pending') = (decided_by is null))
);
create index approvals_pending_idx on public.approvals(company_id, status, requested_at);

alter table public.outreach_messages alter column approval_id type uuid using nullif(approval_id,'')::uuid;
alter table public.outreach_messages add constraint outreach_messages_approval_fk foreign key (approval_id) references public.approvals on delete set null;
create index outreach_messages_approval_idx on public.outreach_messages(approval_id) where approval_id is not null;

alter table public.approvals enable row level security;
create policy approvals_member on public.approvals for select to authenticated using(public.is_company_member(company_id));
create policy approvals_request on public.approvals for insert to authenticated with check(public.has_company_role(company_id,array['owner','executive','operator']));
create policy approvals_decide on public.approvals for update to authenticated using(public.has_company_role(company_id,array['owner','executive'])) with check(public.has_company_role(company_id,array['owner','executive']));
revoke all on public.approvals from anon; grant select,insert,update on public.approvals to authenticated;

do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('demo-previews','demo-previews',true) on conflict (id) do nothing;
  end if;
end $$;
