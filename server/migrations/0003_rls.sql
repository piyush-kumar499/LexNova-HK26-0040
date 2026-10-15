-- ============================================================
-- SS-01 — 0003_rls.sql
-- Row Level Security. Access model:
--   * The Android app NEVER talks to these tables directly.
--   * There is no Supabase Auth user in this system (device identity only).
--   * The only legitimate database client is the server, using the
--     service-role key, which bypasses RLS.
-- Therefore RLS is enabled with ZERO policies (deny-all by default) and
-- table/function privileges are revoked from anon/authenticated. Nothing
-- but the service role can read or write any of this data.
-- ============================================================

-- 1) Enable RLS on every table.
alter table public.devices               enable row level security;
alter table public.device_locations      enable row level security;
alter table public.trusted_contacts      enable row level security;
alter table public.sos_incidents         enable row level security;
alter table public.incident_evidence     enable row level security;
alter table public.incident_recipients   enable row level security;
alter table public.incident_responders   enable row level security;
alter table public.responder_events      enable row level security;
alter table public.call_events           enable row level security;
alter table public.audit_logs            enable row level security;

-- 2) Revoke table privileges from client roles. No policies exist, so even
--    if Supabase's default grants reappear, RLS still denies every row.
revoke all on public.devices             from anon, authenticated;
revoke all on public.device_locations    from anon, authenticated;
revoke all on public.trusted_contacts    from anon, authenticated;
revoke all on public.sos_incidents       from anon, authenticated;
revoke all on public.incident_evidence   from anon, authenticated;
revoke all on public.incident_recipients from anon, authenticated;
revoke all on public.incident_responders from anon, authenticated;
revoke all on public.responder_events    from anon, authenticated;
revoke all on public.call_events         from anon, authenticated;
revoke all on public.audit_logs          from anon, authenticated;

-- 3) RPC functions: executable by the service role only.
revoke execute on function public.upsert_device_location(uuid, double precision, double precision, numeric, timestamptz) from public, anon, authenticated;
revoke execute on function public.latest_device_location(uuid) from public, anon, authenticated;
revoke execute on function public.nearby_devices(double precision, double precision, double precision, integer, uuid, integer) from public, anon, authenticated;
revoke execute on function public.nearby_active_incidents(double precision, double precision, double precision, integer, uuid) from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

grant execute on function public.upsert_device_location(uuid, double precision, double precision, numeric, timestamptz) to service_role;
grant execute on function public.latest_device_location(uuid) to service_role;
grant execute on function public.nearby_devices(double precision, double precision, double precision, integer, uuid, integer) to service_role;
grant execute on function public.nearby_active_incidents(double precision, double precision, double precision, integer, uuid) to service_role;
