-- ============================================================
-- SS-01 — 0001_init.sql
-- Core schema. Tables: devices, device_locations, trusted_contacts,
-- sos_incidents, incident_evidence, incident_recipients,
-- incident_responders, responder_events, call_events, audit_logs.
--
-- Identity model: device-based, no login. There is intentionally NO "role"
-- column anywhere — a device can request help and respond; role is derived
-- per incident from incident_responders membership.
-- ============================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- devices — one row per physical device (the identity)
-- ------------------------------------------------------------
create table if not exists public.devices (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid unique not null,
  display_name    text,
  phone_number    text,                       -- optional, used as Vapi call target
  is_active       boolean not null default true,
  can_respond     boolean not null default true, -- user can turn off helping
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_seen_at    timestamptz
);

create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- device_locations — latest location only, one row per device.
-- Old rows are never retained: the row is upserted in place.
-- ------------------------------------------------------------
create table if not exists public.device_locations (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null unique references public.devices(device_id) on delete cascade,
  location    geography(Point, 4326) not null,
  accuracy    numeric,
  captured_at timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists device_locations_location_gix
  on public.device_locations using gist (location);

create trigger device_locations_set_updated_at
  before update on public.device_locations
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- trusted_contacts — phone numbers Vapi calls on SOS, in priority order
-- ------------------------------------------------------------
create table if not exists public.trusted_contacts (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references public.devices(device_id) on delete cascade,
  contact_name text not null,
  phone_number text not null,
  priority     integer not null default 1 check (priority >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (device_id, phone_number)
);

create index if not exists trusted_contacts_device_priority_idx
  on public.trusted_contacts (device_id, priority);

create trigger trusted_contacts_set_updated_at
  before update on public.trusted_contacts
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- sos_incidents — the incident record.
-- Allowed statuses match the state machine in spec §9.
-- ------------------------------------------------------------
create table if not exists public.sos_incidents (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references public.devices(device_id) on delete cascade,
  status            text not null default 'CREATED'
    check (status in ('CREATED','ACTIVE','HELP_REQUESTED','RESPONDER_ACKNOWLEDGED','RESOLVED','CANCELLED')),
  trigger_type      text not null check (trigger_type in ('shake','button','voice')),
  latitude          double precision,
  longitude         double precision,
  location_accuracy numeric,
  device_timestamp  timestamptz not null,     -- when the device triggered SOS (may be in the past, offline queue)
  activated_at      timestamptz not null,     -- effective activation time (offline events keep their original time)
  escalation_level  integer not null default 0 check (escalation_level >= 0),
  client_request_id text not null,            -- idempotency key from the app
  cancel_reason     text,
  resolution_reason text,
  cancelled_at      timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (device_id, client_request_id),
  constraint sos_incidents_location_pair check ((latitude is null) = (longitude is null))
);

create index if not exists sos_incidents_open_status_idx
  on public.sos_incidents (status)
  where status in ('CREATED','ACTIVE','HELP_REQUESTED','RESPONDER_ACKNOWLEDGED');

create index if not exists sos_incidents_geo_gix
  on public.sos_incidents
  using gist (st_setsrid(st_makepoint(longitude, latitude), 4326)::geography)
  where latitude is not null and longitude is not null;

create trigger sos_incidents_set_updated_at
  before update on public.sos_incidents
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- incident_evidence — references to provider media (Vapi recording URLs).
-- Choice (spec §7): we store the Vapi reference URL, not a re-hosted copy.
-- ------------------------------------------------------------
create table if not exists public.incident_evidence (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.sos_incidents(id) on delete cascade,
  kind        text not null check (kind in ('call_recording','call_transcript')),
  storage_ref text not null,                  -- Vapi reference URL (provider-side)
  media_type  text,
  captured_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists incident_evidence_incident_idx
  on public.incident_evidence (incident_id);

-- ------------------------------------------------------------
-- incident_recipients — notification targets + delivery truth.
-- Delivery, acknowledgement and failure are separate facts.
-- ------------------------------------------------------------
create table if not exists public.incident_recipients (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         uuid not null references public.sos_incidents(id) on delete cascade,
  recipient_type      text not null check (recipient_type in ('trusted_contact','nearby_device','response_team')),
  recipient_reference text not null,          -- trusted_contact id (uuid as text) or device uuid
  level               integer not null default 1 check (level >= 1),
  delivery_status     text not null default 'PENDING'
    check (delivery_status in ('PENDING','ATTEMPTED','DELIVERED','ACKNOWLEDGED','FAILED','DECLINED')),
  provider_reference  text,                   -- provider call id when applicable
  acknowledged_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (incident_id, recipient_type, recipient_reference, level)
);

create index if not exists incident_recipients_incident_idx
  on public.incident_recipients (incident_id);

create trigger incident_recipients_set_updated_at
  before update on public.incident_recipients
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- incident_responders — per-incident membership. THIS is the "role":
-- one row per device per incident, with its own lifecycle.
-- ------------------------------------------------------------
create table if not exists public.incident_responders (
  incident_id         uuid not null references public.sos_incidents(id) on delete cascade,
  device_id           uuid not null references public.devices(device_id) on delete cascade,
  status              text not null default 'NOTIFIED'
    check (status in ('NOTIFIED','ACCEPTED','DECLINED','EN_ROUTE','ARRIVED','WITHDRAWN')),
  distance_at_notify_m numeric,
  notified_at         timestamptz not null default now(),
  accepted_at         timestamptz,
  declined_at         timestamptz,
  en_route_at         timestamptz,
  arrived_at          timestamptz,
  withdrawn_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (incident_id, device_id)
);

create index if not exists incident_responders_device_idx
  on public.incident_responders (device_id);

create trigger incident_responders_set_updated_at
  before update on public.incident_responders
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- responder_events — append-only audit of responder actions.
-- Application code treats this table as insert-only.
-- ------------------------------------------------------------
create table if not exists public.responder_events (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid not null references public.sos_incidents(id) on delete cascade,
  device_id      uuid not null,
  event_type     text not null,
  event_metadata jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists responder_events_incident_idx
  on public.responder_events (incident_id, created_at);

-- ------------------------------------------------------------
-- call_events — provider call truth (Vapi or mock).
-- idempotency_key = incident:<id>:recipient:<ref>:level:<n> prevents
-- duplicate outbound calls for the same recipient and escalation level.
-- ------------------------------------------------------------
create table if not exists public.call_events (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         uuid not null references public.sos_incidents(id) on delete cascade,
  provider            text not null default 'vapi' check (provider in ('vapi','mock')),
  call_reference      text unique,            -- provider call id
  idempotency_key     text unique,
  recipient_reference text,
  level               integer,
  attempt             integer not null default 1,
  status              text not null default 'QUEUED'
    check (status in ('QUEUED','RINGING','IN_PROGRESS','ANSWERED','ENDED','NO_ANSWER','FAILED')),
  ended_reason        text,
  started_at          timestamptz,
  answered_at         timestamptz,
  ended_at            timestamptz,
  recording_ref       text,
  transcript          text,
  raw_event           jsonb,                  -- latest raw provider payload for audit
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists call_events_incident_idx
  on public.call_events (incident_id, created_at);

create trigger call_events_set_updated_at
  before update on public.call_events
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- audit_logs — security-relevant + lifecycle events. No foreign keys on
-- purpose: the audit trail must survive and never block deletions.
-- ------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid,
  incident_id uuid,
  event_type  text not null,
  event_data  jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_incident_idx
  on public.audit_logs (incident_id, created_at);

create index if not exists audit_logs_created_idx
  on public.audit_logs (created_at);
