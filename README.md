# LexNova — Smart Personal Safety & Emergency Response System

> Hackathon submission **HK26-0040** · Problem statement **SS-01**
> Team repository: `piyush-kumar499/LexNova-HK26-0040`

LexNova is an Android personal-safety application: a user in danger activates an SOS, the
system records a location-backed incident, notifies trusted contacts, and lets nearby app
users choose to respond — per incident, without any permanent "helper" or "victim" account
type.

---

## 1. Current status — read this first

**This repository currently contains documentation only.** No application code, migrations,
or tests have been committed yet. Every row below marked ⬜ is a target from the project
specification, not delivered work.

| Area | Status |
| --- | --- |
| Project specification captured, architecture and security model documented | ✅ this document |
| Kotlin / Jetpack Compose Android project | ⬜ not started |
| Supabase schema migrations, RLS policies, Storage policies | ⬜ not drafted |
| SOS state machine | ⬜ designed here, not implemented |
| Dynamic per-incident role model (§6) | ⬜ designed here, not implemented |
| Shake / location / camera modules | ⬜ not started |
| Nearby-responder discovery (PostGIS) | ⬜ not started |
| Unit + authorization tests | ⬜ not written |
| FCM, Vapi, WebRTC, Maps integrations | ⬜ external — need credentials/authorization (§9) |

Nothing in this README should be read as "this works". It describes what will be built and
how it must behave.

---

## 2. Problem statement

Existing safety apps treat the person in danger as passive and the responder as a
pre-registered role. Real emergencies do not respect that split: the person who helps today
may need help tomorrow. LexNova therefore:

- makes **every authenticated user** both a potential requester and a potential responder;
- authorizes information **per incident**, not per account type;
- keeps precise location and media private by default;
- records an audit trail so no claim of "police notified" is made without confirmation.

Safety target: **a reliable, secure emergency foundation matters more than a large number of
unfinished features.**

---

## 3. Technology stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Mobile app | Kotlin, Jetpack Compose, Material 3 | MVVM, Coroutines + Flow, Navigation Compose |
| Device capabilities | Android Sensor API (shake), Fused Location Provider, CameraX, audio APIs | Permissions handled explicitly, no background-execution workarounds |
| Backend platform | Supabase: PostgreSQL, Auth, Storage, Realtime | Primary database and auth authority |
| Geospatial | PostGIS | Radius-based nearby-user discovery |
| Privileged operations | Supabase Edge Functions, or a Python FastAPI service | Server-side validation and trusted dispatch |
| Notifications | Firebase Cloud Messaging | Planned — later phase |
| Voice/AI calls | Vapi | Planned, backend-only, later phase |
| Live media | WebRTC | Planned interface only |
| Maps | Google Maps Platform or equivalent | Planned |

Constraints from the specification: no Flutter or React Native replacement; Supabase remains
the primary database and backend.

**Dependency versions:** pinned at first scaffold in `gradle/libs.versions.toml` (and the
backend manifest at `services/`). They are not listed here because nothing has been resolved
or built yet — when the project is created, the file becomes the source of truth and this
section links to it.

---

## 4. Project layout

Planned package/module boundaries (Android), one per responsibility:

```
app/
  auth/          session, sign-in, profile bootstrap
  home/          post-login landing, permission state
  sos/           activation, incident state machine, cancel/resolve
  sensors/       shake detection + false-positive protection
  location/      permission flow, fixes, last-known-location
  camera/        CameraX capture, availability handling
  evidence/      metadata, upload status, retry, retention
  emergency/     trusted-contact and escalation workflows
  nearby/        responder eligibility, alert accept/decline
  contacts/      trusted-contact CRUD
  calling/       provider interface (mock + real adapter)
  checkin/       safety check-in
  maps/          mapping surface
  settings/      shake sensitivity, false-alarm handling, privacy toggles
  data/          repositories, Supabase clients, DTOs
  domain/        models, use cases, state machines
  security/      authorization helpers, token/secret guards
  core/          DI, logging, error taxonomy, utilities
supabase/
  migrations/    version-controlled SQL (schema, indexes, RLS, storage)
  functions/     privileged edge functions
services/        optional FastAPI service for privileged operations
tests/           unit, state-machine, authorization, integration-mock
.env.example     placeholders only
```

Repositories + dependency injection, typed models, and strict separation of UI, business
logic, and data access.

---

## 5. SOS workflow and incident state machine

Foundation flow:

1. User signs in.
2. User grants required permissions.
3. User configures trusted emergency contacts.
4. User activates SOS via the prominent button (shake trigger is optional and configurable,
   with false-positive protection).
5. A unique incident ID is created.
6. Activation timestamp and available location are recorded.
7. The incident is written to Supabase through an authenticated, server-validated operation.
8. The app shows live incident status.
9. A false alarm can be cancelled through an explicit safe flow.
10. Resolution carries a reason and an audit trail.

Incident states:

```
CREATED → ACTIVE → HELP_REQUESTED → RESPONDER_ACKNOWLEDGED → RESOLVED
    │         │            │
    └─────────┴────────────┴──→ CANCELLED (false alarm)
                                 │
                                 └──→ ESCALATED (no acknowledgement)
```

Transitions are validated **server-side**; invalid transitions are rejected, not silently
ignored.

Notification honesty rule: the app must never state that police, an ambulance, a trusted
contact, or a nearby responder was notified unless the corresponding delivery or
acknowledgement status was actually returned by the receiving service. Delivery,
acknowledgement, acceptance, and failure are tracked as separate facts.

---

## 6. Dynamic per-incident roles

**There is no account-level "Help Seeker" versus "Helper/Responder" choice at registration.**
A user's role is a property of a single incident, derived from their action and authorization
in that incident. The same account can request help in one incident and respond in another,
with no profile change.

### 6.1 Required behavior

| # | Behavior |
| --- | --- |
| 1 | Every authenticated user can activate SOS, subject to safety controls |
| 2 | On SOS creation, the system identifies eligible nearby users from their latest permitted location, availability, and proximity |
| 3 | Eligible users get an assist request notification |
| 4 | The user accepts or declines — no prior helper registration required |
| 5 | Accepting makes them a responder **for that incident only** |
| 6 | That responder can later be an SOS owner in a different incident |
| 7 | The original SOS owner remains the incident owner after responders join |
| 8 | Only authorized responders receive incident-specific information; exact location, live video/audio, and sensitive evidence are never broadcast to all nearby users |
| 9 | A user can stop responding / withdraw, and the backend updates their responder status |
| 10 | If nobody accepts, the notification radius expands per configurable policy while trusted-contact and emergency escalation continue |

### 6.2 Statuses — tracked separately, never merged

SOS owner status:

```
REQUESTING_HELP → HELP_RECEIVED → RESOLVED
                                  ↘ CANCELLED
```

Per-incident responder status (a separate membership record, one row per user per incident):

```
NOTIFIED → ACCEPTED → EN_ROUTE → ARRIVED → (help recorded)
    │          │                      
    └→ DECLINED└→ WITHDRAWN           
```

Accepting an alert does **not** imply arrival, and arrival does not imply the person was
successfully helped. These are distinct events and are stored and reported as such.

### 6.3 Data model for roles

Membership lives in an incident-specific responder table, not in `profiles`:

```
incident_responders
  incident_id     → sos_incidents.id
  responder_id    → auth.users.id
  status          → NOTIFIED | ACCEPTED | DECLINED | EN_ROUTE | ARRIVED | WITHDRAWN
  notified_at, accepted_at, arrived_at, withdrawn_at
  eligibility_source (radius, distance_at_notify, policy_version)
  granted_scope   → which fields this responder may read for this incident
  pk (incident_id, responder_id)
```

Responder activity is appended to `responder_events` (append-only audit). Authorization is
enforced by RLS policies keyed on membership plus backend checks. A role supplied by the
client — a role string, a user ID, an incident ID claimed as "mine" — is never trusted; it is
always re-derived server-side from the authenticated principal and the membership row.

### 6.4 Abuse prevention

- authenticated users + server-side authorization on every read/write;
- rate limiting and duplicate-alert protection on SOS creation and escalation;
- incident audit log for security-relevant actions;
- precise location never broadcast area-wide; disclosure is per authorized responder;
- camera evidence and live streams not auto-shared with nearby users;
- incident owner controls who sees incident detail, subject to emergency and legal duty;
- nearby users are treated as *unverified* by default — proximity is not trust;
- report-suspicious-responder and block-user flows;
- UI presents "request help" and "offer help" as contextual actions, never as account types.

---

## 7. Database (Supabase PostgreSQL + PostGIS)

Version-controlled migrations for:

| Table | Purpose | Key fields |
| --- | --- | --- |
| `profiles` | app-visible identity | `id`, `display_name`, `phone_number` (only if required), `created_at`, `updated_at` |
| `trusted_contacts` | owner's emergency contacts | `id`, `owner_id`, `contact_name`, `phone_number`, `notification_preferences`, `created_at` |
| `sos_incidents` | the incident record | `id`, `user_id`, `status`, `trigger_type`, `latitude`, `longitude`, `location_accuracy`, `activated_at`, `last_location_at`, `resolved_at`, `resolution_reason`, `created_at` |
| `incident_evidence` | media metadata | `id`, `incident_id`, `owner_id`, `storage_path`, `media_type`, `captured_at`, `upload_status`, `retention_until`, `created_at` |
| `incident_recipients` | notification targets + delivery truth | `id`, `incident_id`, `recipient_type`, `recipient_reference`, `delivery_status`, `acknowledged_at`, `created_at` |
| `responder_events` | append-only responder audit | `id`, `incident_id`, `responder_id`, `event_type`, `event_metadata`, `created_at` |
| `call_events` | provider call truth | `id`, `incident_id`, `provider`, `call_reference`, `call_status`, `started_at`, `ended_at`, `created_at` |
| `incident_responders` | §6 per-incident membership/role | see §6.3 |

All identifiers are UUIDs. Foreign keys, check constraints on enum-like fields, `updated_at`
triggers, and PostGIS `geography` columns with spatial indexes are part of the migrations.

Minimization: no unnecessary sensitive data; precise coordinates and media collected only as
needed; retention windows enforced (`retention_until`) with a documented deletion path.

---

## 8. Security model

Security is a hard requirement, not a phase.

- **RLS enabled on every table containing user or incident data.**
- A user cannot read another user's private incidents, evidence, or trusted contacts.
- A nearby responder sees only fields authorized for that incident and their membership
  scope; the location needed to assist is granted at `ACCEPTED`, not at `NOTIFIED`.
- **The Supabase service-role key never ships in the Android app.**
- **The Vapi private API key never ships in the Android app.**
- Privileged operations run on trusted backend (Edge Function / FastAPI) only.
- Server-side validation of: incident ownership, state transitions, payload shape, rate
  limits, idempotency keys.
- Evidence in **private** Storage buckets, accessed via short-lived signed URLs.
- Rate limits + idempotency on SOS creation and escalation (duplicate taps must not create
  duplicate incidents or duplicate dispatch calls).
- Audit trail for security-relevant actions.
- Documented data-deletion and incident-retention policy.

Test requirement: automated cases proving one user cannot access another user's incidents,
evidence, or trusted contacts, and cannot forge responder membership.

---

## 9. Integrations that are **not** working yet

No integration below is implemented. Credentials, paid plans, or formal authorization are
prerequisites, and none has been obtained in this repository. Development uses mock providers
only; no real emergency call is placed by any test or demo.

| Integration | State | What it actually needs |
| --- | --- | --- |
| FCM push notifications | ⬜ not integrated | Firebase project, server credentials, notification permissions |
| Vapi AI calls | ⬜ interface only | Vapi account + private API key held server-side; provider webhook validation |
| WebRTC live video/audio | ⬜ interface only | Signaling path, TURN/STUN infrastructure, explicit consent flow |
| Google Maps | ⬜ not integrated | Billing-enabled API key, usage-policy review |
| Police / ambulance dispatch | ⬜ no integration exists | Official emergency-service API or authorized partnership. Without it, escalation notifies trusted contacts and the user; it does **not** claim dispatch. Success is recorded only on receiving-service confirmation |

Emergency triage (planned backend interface) categories: personal security threat, physical
injury/accident, medical emergency, unknown/unconfirmed. Rules: no crime or diagnosis inferred
from a photograph alone; uncertain or unresponsive cases take a conservative fallback that
never delays assistance.

Camera/evidence constraints to honor at implementation: capture only when permissions and
platform conditions allow; degrade cleanly on denied permission, no camera, poor connectivity,
or full storage; do not assume capture works while the device is locked or another app is
foreground.

Nearby discovery constraints: PostGIS radius queries, configurable radius, auto-expansion on
no-acceptance per policy, precise coordinates private by default, delivery / acknowledgement /
acceptance / failure tracked separately.

---

## 10. UI requirements

Sign-in · home · large SOS button · current location + permission status · trusted-contact
management · active incident screen (owner view) · incoming assist request + responder status
view · evidence upload status · emergency response status · settings for shake sensitivity and
false-alarm handling.

Material 3, clean and readable. No heavy animation on the SOS path. Status is conveyed by text
**and** icon, never color alone. Usable at large text sizes and with accessibility services.
Requesting help and offering help appear as contextual actions in the moment — the app must not
present them as account types anywhere.

---

## 11. Setup (to be completed with the first scaffold)

Prerequisites: Android Studio with the JDK required by the AGP version pinned at scaffold
time, Node or Deno for Supabase CLI tooling, a Supabase project, and a physical Android
device for sensor/camera/location testing.

```
# planned — these commands become valid once the project and migrations exist
git clone https://github.com/piyush-kumar499/LexNova-HK26-0040.git
cd LexNova-HK26-0040
cp .env.example app/src/main/assets/env.properties   # placeholders; real values never committed
supabase link --project-ref <your-ref>
supabase db push            # applies version-controlled migrations + RLS
./gradlew :app:assembleDebug
```

Supabase setup guide, `.env.example` template with placeholders only, and the local
development guide are deliverables of the foundation phase and are not written yet.

Never commit real keys. The service-role key and Vapi private key stay server-side.

---

## 12. Testing

Minimum scenarios required by the specification:

- normal SOS activation;
- duplicate SOS requests (idempotency);
- false-alarm cancellation;
- missing location permission;
- camera permission denied;
- evidence upload failure and retry;
- offline mode and reconnection;
- unauthorized access to another user's incident / evidence / contacts;
- duplicate notification and calling requests;
- failed or unanswered responder notification.

Role-system cases (unit + backend authorization, both required to pass):

- a single account activates SOS as owner in incident A, and is notified and accepts as
  responder in incident B, **with no change to any account-level field**;
- acceptance in incident B does not grant read access to incident A's precise location or
  evidence;
- the SOS owner of incident A remains owner after responder C joins;
- status transitions: `ACCEPTED` does not imply `ARRIVED`; `WITHDRAWN` stops further
  assignment and updates the membership row;
- no acceptance within the window expands the radius per policy and continues escalation;
- a client-supplied role or user ID is rejected by the server;
- duplicate-assist protection: two concurrent accepts resolve to one membership record.

Test frameworks and their pinned versions are chosen at first scaffold. Until code exists,
no test result should be reported for this project.

---

## 13. Roadmap

1. **Foundation** — Android project, DI, navigation, Supabase link, migrations + RLS, SOS
   state machine, tests for owner isolation.
2. **Dynamic roles** — `incident_responders`, accept/decline/en-route/arrived/withdraw flows,
   per-incident authorization, radius expansion policy, abuse controls.
3. **Sensors and evidence** — shake detection with false-positive protection, CameraX capture,
   private Storage upload with retry and retention.
4. **Nearby discovery** — PostGIS eligibility queries, notification service interface, delivery
   truth tracking.
5. **Escalation** — triage engine, trusted-contact escalation, documented real-world dispatch
   requirements (no fabricated integrations).
6. **Calling and live media** — mock-first Vapi adapter, then real provider when credentials and
   authorization exist; WebRTC interface.
7. **Hardening** — security review, rate limiting, audit, accessibility, retention and deletion
   enforcement.

## Known limitations

- Documentation-only state: no build, no tests, no deployed backend exists yet.
- Emergency-service dispatch is out of reach without official integration or authorization;
  until then the product assists and informs, and must be described that way in all copy.
- Responder trust cannot be established by proximity alone; background vetting is a product and
  legal decision this repository has not made.
- Battery, foreground-service, and doze limitations on real devices are unmeasured — no
  performance figures are claimed.
- Privacy/legal review (consent, evidence admissibility, data residency, retention) is still
  required before any production deployment.

---

LexNova · HK26-0040 · problem statement SS-01 — safety and authorization rules in this README
come directly from the project specification and are binding on the implementation.
