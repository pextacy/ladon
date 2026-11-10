-- Ladon web app schema. Matches docs/PLAN.md §2, plus pair_codes, passkeys and decisions.
-- The server talks to Postgres only with the service key. RLS is enabled on every table with no
-- policies, so the anon/authenticated roles can read and write nothing.

create extension if not exists pgcrypto;

-- A paired machine running the Ladon daemon. kind='passkey' devices approve with WebAuthn,
-- kind='key' devices with the Ladon Key (verified locally by the daemon).
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null,
  kind text not null default 'passkey' check (kind in ('key', 'passkey')),
  public_key bytea null,
  label text not null,
  token_hash text not null unique,          -- sha256(deviceToken) hex; the token is never stored
  created_at timestamptz not null default now()
);

create table if not exists pair_codes (
  code text primary key check (code ~ '^[A-Z2-9]{8}$'),
  device_id uuid not null references devices(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz null,
  challenge text null,                       -- current WebAuthn registration challenge
  created_at timestamptz not null default now()
);

create table if not exists passkeys (
  credential_id text primary key,            -- base64url
  device_id uuid not null references devices(id) on delete cascade,
  public_key text not null,                  -- base64url COSE key
  counter bigint not null default 0,
  label text not null default '',
  transports text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists passkeys_device_idx on passkeys(device_id);

-- id is chosen by the daemon (core newRequestId), so it is text rather than uuid.
create table if not exists approval_requests (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{4,64}$'),
  device_id uuid not null references devices(id) on delete cascade,
  user_id uuid null,
  command_hash text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  nonce text not null,
  exp bigint not null,                       -- unix seconds
  ecosystem text not null check (ecosystem in ('npm', 'pypi')),
  package text not null,
  version text null,
  score int not null check (score between 0 and 100),
  reasons jsonb not null default '[]',
  intent jsonb null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decision text null check (decision in ('approve', 'reject')),
  decided_by text null,                      -- passkey credential id
  decided_at timestamptz null,
  signature bytea null,                      -- reserved for Ladon Key signatures
  assertion jsonb null,                      -- raw WebAuthn AuthenticationResponseJSON
  created_at timestamptz not null default now()
);
create index if not exists approvals_device_idx on approval_requests(device_id, created_at desc);

create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  ts timestamptz not null,
  ecosystem text not null check (ecosystem in ('npm', 'pypi')),
  package text not null,
  version text null,
  verdict text not null check (verdict in ('allow', 'warn', 'hold')),
  score int not null check (score between 0 and 100),
  reasons jsonb not null default '[]',
  outcome text not null check (outcome in ('allowed', 'warned', 'approved', 'rejected', 'timeout', 'blocked')),
  via text null check (via in ('key', 'passkey')),
  agent text null,
  created_at timestamptz not null default now()
);
create index if not exists decisions_device_idx on decisions(device_id, ts desc);

create table if not exists atlas_names (
  ecosystem text not null check (ecosystem in ('npm', 'pypi')),
  name text not null,
  first_seen timestamptz not null default now(),
  models text[] not null default '{}',
  seen_count int not null default 1,
  registered bool not null default false,
  registered_at timestamptz null,
  source text null,
  last_checked timestamptz null,
  primary key (ecosystem, name)
);
create index if not exists atlas_names_name_idx on atlas_names(name text_pattern_ops);

-- Opt-in reports: package name + registry + model only. Never prompts, code, paths or env.
create table if not exists atlas_reports (
  id bigserial primary key,
  ecosystem text not null check (ecosystem in ('npm', 'pypi')),
  name text not null,
  model text null,
  ts timestamptz not null default now()
);

create table if not exists verdict_cache (
  ecosystem text not null,
  name text not null,
  version text not null,
  evidence jsonb not null,
  score int not null,
  computed_at timestamptz not null default now(),
  primary key (ecosystem, name, version)
);

-- Atomic upsert used by the probe job and opt-in reports.
create or replace function atlas_observe(p_ecosystem text, p_name text, p_model text, p_source text, p_registered bool, p_at timestamptz)
returns void language sql security definer set search_path = public as $$
  insert into atlas_names (ecosystem, name, first_seen, models, seen_count, registered, source, last_checked)
  values (p_ecosystem, p_name, p_at, case when p_model is null then '{}' else array[p_model] end, 1, p_registered, p_source, p_at)
  on conflict (ecosystem, name) do update set
    seen_count = atlas_names.seen_count + 1,
    models = case
      when p_model is null or p_model = any(atlas_names.models) then atlas_names.models
      else array_append(atlas_names.models, p_model) end,
    source = coalesce(atlas_names.source, excluded.source);
$$;
revoke all on function atlas_observe(text, text, text, text, bool, timestamptz) from public, anon, authenticated;

alter table devices enable row level security;
alter table pair_codes enable row level security;
alter table passkeys enable row level security;
alter table approval_requests enable row level security;
alter table decisions enable row level security;
alter table atlas_names enable row level security;
alter table atlas_reports enable row level security;
alter table verdict_cache enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) can access these tables.
