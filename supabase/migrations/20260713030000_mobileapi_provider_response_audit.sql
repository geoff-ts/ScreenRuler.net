alter table public.mobileapi_lookup_audit
    add column if not exists provider_response jsonb;
