-- ============================================================
-- SS-01 — 0002_functions.sql
-- PostGIS-backed RPC functions used by the server (service role only).
-- The server never builds raw SQL: all geo math lives here.
-- ============================================================

-- Upsert the single latest location row for a device.
create or replace function public.upsert_device_location(
  p_device_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy numeric,
  p_captured_at timestamptz
) returns void
language sql
as $$
  insert into public.device_locations (device_id, location, accuracy, captured_at)
  values (
    p_device_id,
    st_setsrid(st_makepoint(p_longitude, p_latitude), 4326)::geography,
    p_accuracy,
    p_captured_at
  )
  on conflict (device_id) do update
    set location    = excluded.location,
        accuracy    = excluded.accuracy,
        captured_at = excluded.captured_at,
        updated_at  = now();
$$;

-- Latest known location for one device (null row if never reported).
create or replace function public.latest_device_location(
  p_device_id uuid
) returns table (
  latitude double precision,
  longitude double precision,
  accuracy numeric,
  captured_at timestamptz
)
language sql
stable
as $$
  select st_y(dl.location::geometry),
         st_x(dl.location::geometry),
         dl.accuracy,
         dl.captured_at
  from public.device_locations dl
  where dl.device_id = p_device_id;
$$;

-- Devices near a point: fresh locations only, devices must be active and
-- have responding enabled (can_respond), requester excluded.
create or replace function public.nearby_devices(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision,
  p_max_results integer,
  p_exclude_device_id uuid,
  p_max_age_minutes integer default 10
) returns table (
  device_id uuid,
  distance_m double precision
)
language sql
stable
as $$
  with origin as (
    select st_setsrid(st_makepoint(p_longitude, p_latitude), 4326)::geography as g
  )
  select d.device_id,
         st_distance(dl.location, o.g) as distance_m
  from public.device_locations dl
  join public.devices d on d.device_id = dl.device_id
  cross join origin o
  where st_dwithin(dl.location, o.g, p_radius_meters)
    and dl.captured_at > now() - make_interval(mins => p_max_age_minutes)
    and dl.device_id <> p_exclude_device_id
    and d.is_active
    and d.can_respond
  order by distance_m asc
  limit greatest(p_max_results, 1);
$$;

-- Open SOS incidents near a point (polling fallback for /nearby/sos).
-- Terminal incidents (RESOLVED, CANCELLED) are excluded.
create or replace function public.nearby_active_incidents(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision,
  p_max_results integer,
  p_exclude_device_id uuid
) returns table (
  incident_id uuid,
  distance_m double precision,
  trigger_type text,
  activated_at timestamptz
)
language sql
stable
as $$
  with origin as (
    select st_setsrid(st_makepoint(p_longitude, p_latitude), 4326)::geography as g
  )
  select i.id,
         st_distance(
           st_setsrid(st_makepoint(i.longitude, i.latitude), 4326)::geography,
           o.g
         ) as distance_m,
         i.trigger_type,
         i.activated_at
  from public.sos_incidents i
  cross join origin o
  where i.latitude is not null
    and i.longitude is not null
    and i.status not in ('RESOLVED','CANCELLED')
    and i.device_id <> p_exclude_device_id
    and st_dwithin(
      st_setsrid(st_makepoint(i.longitude, i.latitude), 4326)::geography,
      o.g,
      p_radius_meters
    )
  order by distance_m asc
  limit greatest(p_max_results, 1);
$$;
