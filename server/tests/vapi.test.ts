import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  makeTestApp,
  makeTestConfig,
  waitFor,
  VALID_DEVICE_ID,
  type TestApp,
} from "./helpers/setup.js";
import {
  MockVapiClient,
  VapiRestClient,
  createCallProvider,
  normalizeVapiCallStatus,
} from "../src/services/vapi.service.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };

const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as FastifyBaseLogger;

function sosBody(clientRequestId: string): Record<string, unknown> {
  return {
    triggerType: "button",
    latitude: 28.6139,
    longitude: 77.209,
    locationAccuracy: 10,
    deviceTimestamp: new Date().toISOString(),
    clientRequestId,
  };
}

describe("Vapi status normalization", () => {
  it("maps documented Vapi statuses and ended reasons to our enum", () => {
    expect(normalizeVapiCallStatus("scheduled", null)).toBe("QUEUED");
    expect(normalizeVapiCallStatus("queued", null)).toBe("QUEUED");
    expect(normalizeVapiCallStatus("ringing", null)).toBe("RINGING");
    expect(normalizeVapiCallStatus("in-progress", null)).toBe("IN_PROGRESS");
    expect(normalizeVapiCallStatus("forwarding", null)).toBe("IN_PROGRESS");
    expect(normalizeVapiCallStatus("ended", null)).toBe("ENDED");
    expect(normalizeVapiCallStatus("ended", "customer-did-not-answer")).toBe("NO_ANSWER");
    expect(normalizeVapiCallStatus("ended", "customer-busy")).toBe("NO_ANSWER");
    expect(normalizeVapiCallStatus("ended", "voicemail")).toBe("NO_ANSWER");
    expect(normalizeVapiCallStatus("ended", "customer-ended-call")).toBe("ANSWERED");
    expect(normalizeVapiCallStatus("ended", "twilio-failed-to-connect-call")).toBe("FAILED");
    expect(normalizeVapiCallStatus("ended", "assistant-request-failed")).toBe("FAILED");
    expect(normalizeVapiCallStatus("not-found", null)).toBe("FAILED");
    expect(normalizeVapiCallStatus("something-new", null)).toBe("FAILED");
  });
});

describe("call provider selection", () => {
  it("uses the mock provider when Vapi is not fully configured", () => {
    const provider = createCallProvider(makeTestConfig(), silentLog);
    expect(provider).toBeInstanceOf(MockVapiClient);
    expect(provider.provider).toBe("mock");
    expect(provider.mocked).toBe(true);
  });

  it("uses the real provider only when key, phone number and assistant are all present", () => {
    const provider = createCallProvider(
      makeTestConfig({
        VAPI_PRIVATE_KEY: "test-private-key",
        VAPI_PHONE_NUMBER_ID: "test-phone-number-id",
        VAPI_ASSISTANT_ID: "test-assistant-id",
      }),
      silentLog,
    );
    expect(provider).toBeInstanceOf(VapiRestClient);
    expect(provider.provider).toBe("vapi");
    expect(provider.mocked).toBe(false);
  });

  it("stays on the mock provider while any required Vapi value is missing", () => {
    const provider = createCallProvider(
      makeTestConfig({
        VAPI_PRIVATE_KEY: "test-private-key",
        VAPI_PHONE_NUMBER_ID: "test-phone-number-id",
        // VAPI_ASSISTANT_ID missing
      }),
      silentLog,
    );
    expect(provider).toBeInstanceOf(MockVapiClient);
  });
});

describe("SOS notification pipeline (mock provider)", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999000001",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Neighbour",
      phoneNumber: "+919999000002",
      priority: 2,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("places a MOCK call to the priority-1 contact and records the truth", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("vapi-dispatch-1"),
    });
    const incidentId = created.json().incident.id;

    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);

    const [call] = await db.listCallEvents(incidentId);
    expect(call?.provider).toBe("mock");
    expect(call?.status).toBe("ANSWERED");
    expect(call?.recipient_reference).toBe("+919999000001");
    expect(call?.level).toBe(1);
    expect(call?.idempotency_key).toBe(
      `incident:${incidentId}:recipient:+919999000001:level:1:attempt:1`,
    );
    expect(call?.call_reference).toMatch(/^mock-/);

    const recipients = await db.listIncidentRecipients(incidentId);
    const recipient = recipients.find((r) => r.recipient_reference === "+919999000001");
    expect(recipient?.delivery_status).toBe("DELIVERED");
    expect(recipient?.provider_reference).toBe(call?.call_reference);
    // Delivered is not acknowledged — that is a separate fact.
    expect(recipient?.acknowledged_at).toBeNull();

    await waitFor(async () => (await db.getIncident(incidentId))?.status === "HELP_REQUESTED");

    const audit = db.getAuditLogs().filter((e) => e.incident_id === incidentId);
    const attempt = audit.find((e) => e.event_type === "escalation.call_attempted");
    expect(attempt).toBeDefined();
    expect((attempt?.event_data as Record<string, unknown>)?.mocked).toBe(true);
  });

  it("replaying a duplicate SOS does not create a second call", async () => {
    const payload = sosBody("vapi-dispatch-duplicate");
    const first = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    const incidentId = first.json().incident.id;
    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);

    await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    await waitFor(() =>
      db.getAuditLogs().some((e) => e.incident_id === incidentId && e.event_type === "sos.duplicate_replayed"),
    );

    expect((await db.listCallEvents(incidentId)).length).toBe(1);
  });

  it("notifyRecipient is idempotent per (recipient, level, attempt)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("vapi-idempotency-1"),
    });
    const incidentId = created.json().incident.id;
    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);

    const incident = await db.getIncident(incidentId);
    const contact = (await db.listTrustedContacts(VALID_DEVICE_ID))[0]!;
    await app.ctx.escalation.notifyRecipient(
      incident!,
      {
        recipientType: "trusted_contact",
        reference: contact.phone_number,
        toNumber: contact.phone_number,
        distanceM: null,
        label: contact.contact_name,
      },
      1,
    );

    expect((await db.listCallEvents(incidentId)).length).toBe(1);
  });

  it("records NO_ANSWER when the mock simulates an unanswered call", async () => {
    const { app: noAnswerApp, db: noAnswerDb } = makeTestApp({
      MOCK_VAPI_OUTCOME: "no-answer",
    });
    await noAnswerDb.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999000001",
      priority: 1,
    });
    await noAnswerApp.ready();

    const created = await noAnswerApp.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("vapi-no-answer-1"),
    });
    const incidentId = created.json().incident.id;

    await waitFor(async () => (await noAnswerDb.listCallEvents(incidentId)).length === 1);

    const [call] = await noAnswerDb.listCallEvents(incidentId);
    expect(call?.status).toBe("NO_ANSWER");
    expect(call?.ended_reason).toBe("customer-did-not-answer");
    expect(call?.answered_at).toBeNull();

    const [recipient] = await noAnswerDb.listIncidentRecipients(incidentId);
    expect(recipient?.delivery_status).toBe("FAILED");
    expect(recipient?.acknowledged_at).toBeNull();

    await noAnswerApp.close();
  });

  it("with no trusted contacts, no calls are placed and the audit says why", async () => {
    const { app: bareApp, db: bareDb } = makeTestApp();
    await bareApp.ready();

    const created = await bareApp.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("vapi-no-contacts-1"),
    });
    const incidentId = created.json().incident.id;

    await waitFor(
      async () => (await bareDb.getIncident(incidentId))?.status === "HELP_REQUESTED",
    );

    expect(await bareDb.listCallEvents(incidentId)).toEqual([]);
    expect(
      bareDb.getAuditLogs().some(
        (e) => e.incident_id === incidentId && e.event_type === "escalation.no_recipients",
      ),
    ).toBe(true);

    await bareApp.close();
  });
});
