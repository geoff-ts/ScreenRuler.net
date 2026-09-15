create table if not exists public.contact_form_rate_limits (
    bucket_key text primary key,
    window_started_at timestamptz not null default now(),
    request_count integer not null default 0 check (request_count >= 0)
);

alter table public.contact_form_rate_limits enable row level security;

create or replace function public.consume_contact_form_quota(
    p_bucket_key text,
    p_limit integer,
    p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    allowed boolean;
begin
    if p_bucket_key is null or length(p_bucket_key) = 0 or p_limit < 1 or p_window_seconds < 1 then
        raise exception 'Invalid rate-limit arguments';
    end if;

    insert into public.contact_form_rate_limits (bucket_key, window_started_at, request_count)
    values (p_bucket_key, now(), 1)
    on conflict (bucket_key) do update
    set window_started_at = case
            when public.contact_form_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
                then now()
            else public.contact_form_rate_limits.window_started_at
        end,
        request_count = case
            when public.contact_form_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
                then 1
            else public.contact_form_rate_limits.request_count + 1
        end
    returning request_count <= p_limit into allowed;

    return allowed;
end;
$$;

revoke all on table public.contact_form_rate_limits from anon, authenticated;
revoke execute on function public.consume_contact_form_quota(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_contact_form_quota(text, integer, integer) to service_role;
