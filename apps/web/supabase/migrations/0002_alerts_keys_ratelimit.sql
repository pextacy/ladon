-- 0002: Atlas alerts view, Ladon Key public keys per device, and a shared rate-limit counter.
-- Same rules as 0001: the server uses only the service key; RLS on, no policies.

-- Names that were registered after we first saw them as hallucinated (the slopsquat early warning).
-- security_invoker so the anon/authenticated roles hit atlas_names' RLS (= nothing) through the view.
create or replace view atlas_alerts with (security_invoker = true) as
  select * from atlas_names
  where registered and registered_at is not null and registered_at > first_seen;
revoke all on atlas_alerts from public, anon, authenticated;
create index if not exists atlas_names_registered_at_idx on atlas_names(registered_at desc) where registered;

-- A Ladon Key paired with a device (docs/PLAN.md §2 devices.kind/public_key). Informational for the
-- dashboard only: the daemon's locally pinned key is what approvals are verified against.
create table if not exists device_keys (
  device_id uuid not null references devices(id) on delete cascade,
  public_key text not null check (public_key ~ '^[0-9a-f]{64}$'),  -- raw Ed25519, hex
  fingerprint text not null check (fingerprint ~ '^[0-9A-F]{8}$'),
  label text not null default '',
  created_at timestamptz not null default now(),
  primary key (device_id, public_key)
);
alter table device_keys enable row level security;

-- Fixed-window counters shared by all server instances (/api/check, /api/check/manifest).
create table if not exists rate_limits (
  bucket text not null,                       -- e.g. "check:203.0.113.7"
  window_start timestamptz not null,
  count int not null default 0,
  primary key (bucket, window_start)
);
alter table rate_limits enable row level security;

-- Adds p_cost to the bucket's current window unless that would exceed p_limit. Atomic (row lock).
create or replace function rate_limit_take(p_bucket text, p_limit int, p_window_seconds int, p_cost int)
returns table (allowed boolean, used int, reset_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  n int;
begin
  insert into rate_limits as r (bucket, window_start, count) values (p_bucket, w, 0)
    on conflict (bucket, window_start) do nothing;
  update rate_limits as r set count = r.count + p_cost
    where r.bucket = p_bucket and r.window_start = w and r.count + p_cost <= p_limit
    returning r.count into n;
  if n is null then
    select r.count into n from rate_limits as r where r.bucket = p_bucket and r.window_start = w;
    allowed := false;
  else
    allowed := true;
  end if;
  used := n;
  reset_at := w + make_interval(secs => p_window_seconds);
  -- opportunistic cleanup of old windows
  if random() < 0.02 then
    delete from rate_limits where window_start < clock_timestamp() - interval '1 day';
  end if;
  return next;
end;
$$;
revoke all on function rate_limit_take(text, int, int, int) from public, anon, authenticated;

-- Functions are executable by PUBLIC by default; only the server (service role) may spend rate-limit budget.
revoke all on function rate_limit_take(text, int, int, int) from public, anon, authenticated;
grant execute on function rate_limit_take(text, int, int, int) to service_role;
