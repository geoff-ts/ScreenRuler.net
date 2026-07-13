create table if not exists public.mobileapi_lookup_audit (
    id bigint generated always as identity primary key,
    created_at timestamptz not null default now(),
    requested_model text not null,
    requested_screen_width integer not null,
    requested_screen_height integer not null,
    provider_status integer not null,
    match_found boolean not null default false,
    matched_brand text,
    matched_name text,
    matched_diagonal numeric(6, 2),
    matched_screen_width integer,
    matched_screen_height integer,
    mobileapi_match jsonb
);

alter table public.mobileapi_lookup_audit enable row level security;

revoke all on table public.mobileapi_lookup_audit from anon, authenticated;
grant select, insert on table public.mobileapi_lookup_audit to service_role;
grant usage, select on sequence public.mobileapi_lookup_audit_id_seq to service_role;
