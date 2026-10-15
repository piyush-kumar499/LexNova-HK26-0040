import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, waitFor, VALID_DEVICE_ID_3, type TestApp } from "./helpers/setup.js";
import { hmacSha256Hex } from "../src/utils/crypto.js";

const WEBHOOK_SECRET = "test-webhook-secret";

describe("Vapi webhook", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp({ VAPI_WEBHOOK_SECRET: WEBHOOK_SECRET }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function processedCount(): number {
    return db
      .getAuditLogs()
      .filter((e) => e.event_type === "vapi.webhook_processed").length;
  }

  async function seedIncidentAndCall(options: {
    deviceId?: string;
    callReference: string;
    recipientPhone?: string | null;
    withRecipient?: boolean;
  }): Promise<{ incidentId: string; callEventId: string }> {
    const deviceId = options.deviceId ?? VALID_DEVICE_ID_3;
    const incident = await db.insertSosIncident({
      deviceId,
      triggerType: "button",
      latitude: 28.6139,
      longitude: 77.209,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      clientRequestId: `seed-${options.callReference}`,
    });
    const callEvent = await db.insertCallEvent({
      incidentId: incident.id,
      provider: "vapi",
      callReference: options.callReference,
      idempotencyKey: null,
      recipientReference: options.recipientPhone ?? null,
      level: 1,
      status: "QUEUED",
    });
    if (options.withRecipient && options.recipientPhone) {
      await db.insertIncidentRecipient({
        incidentId: incident.id,
        recipientType: "trusted_contact",
        recipientReference: options.recipientPhone,
        level: 1,
        deliveryStatus: "ATTEMPTED",
      });
    }
    return { incidentId: incident.id, callEventId: callEvent.id };
  }

  async function postWebhook(
    body: unknown,
    headerMode: "signature" | "bearer" | "none" | "bad" = "signature",
  ) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (headerMode === "signature") {
      headers["x-vapi-signature"] = hmacSha256Hex(WEBHOOK_SECRET, raw);
    } else if (headerMode === "bearer") {
      headers.authorization = `Bearer ${WEBHOOK_SECRET}`;
    } else if (headerMode === "bad") {
      headers["x-vapi-signature"] = "0".repeat(64);
    }
    return app.inject({ method: "POST", url: "/vapi/webhook", headers, payload: raw });
  }

  it("rejects a webhook with no or wrong signature when a secret is configured", async () => {
    const { callEventId } = await seedIncidentAndCall({ callReference: "vapi-call-unsigned" });

    const unsigned = await postWebhook(
      { message: { type: "status-update", status: "ringing", call: { id: "vapi-call-unsigned" } } },
      "none",
    );
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.code).toBe("INVALID_WEBHOOK_SIGNATURE");

    const wrong = await postWebhook(
      { message: { type: "status-update", status: "ringing", call: { id: "vapi-call-unsigned" } } },
      "bad",
    );
    expect(wrong.statusCode).toBe(401);

    const call = await db.findCallEventByReference("vapi-call-unsigned");
    expect(call?.id).toBe(callEventId);
    expect(call?.status).toBe("QUEUED");
  });

  it("accepts an HMAC-signed status-update and applies it", async () => {
    const { incidentId } = await seedIncidentAndCall({
      callReference: "vapi-call-ringing",
      recipientPhone: "+910000000010",
      withRecipient: true,
    });

    const res = await postWebhook({
      message: {
        type: "status-update",
        status: "ringing",
        call: { id: "vapi-call-ringing" },
        timestamp: Date.now(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    await waitFor(async () => (await db.findCallEventByReference("vapi-call-ringing"))?.status === "RINGING");
    const call = await db.findCallEventByReference("vapi-call-ringing");
    expect(call?.started_at).toBeTruthy();

    const recipients = await db.listIncidentRecipients(incidentId);
    const recipient = recipients.find((r) => r.recipient_reference === "+910000000010");
    expect(recipient?.delivery_status).toBe("ATTEMPTED");
  });

  it("accepts the documented Bearer auth and records an answered call", async () => {
    const { incidentId } = await seedIncidentAndCall({
      callReference: "vapi-call-answered",
      recipientPhone: "+910000000011",
      withRecipient: true,
    });

    const res = await postWebhook(
      {
        message: {
          type: "status-update",
          status: "in-progress",
          call: { id: "vapi-call-answered" },
        },
      },
      "bearer",
    );
    expect(res.statusCode).toBe(200);

    await waitFor(async () => (await db.findCallEventByReference("vapi-call-answered"))?.status === "IN_PROGRESS");
    const call = await db.findCallEventByReference("vapi-call-answered");
    expect(call?.answered_at).toBeTruthy();

    const recipients = await db.listIncidentRecipients(incidentId);
    const recipient = recipients.find((r) => r.recipient_reference === "+910000000011");
    expect(recipient?.delivery_status).toBe("DELIVERED");
  });

  it("moves to the next trusted contact when a call is not answered", async () => {
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID_3,
      contactName: "First",
      phoneNumber: "+910000000001",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID_3,
      contactName: "Second",
      phoneNumber: "+910000000002",
      priority: 2,
    });
    const { incidentId } = await seedIncidentAndCall({
      callReference: "vapi-call-no-answer",
      recipientPhone: "+910000000001",
      withRecipient: true,
    });

    const res = await postWebhook({
      message: {
        type: "status-update",
        status: "ended",
        endedReason: "customer-did-not-answer",
        call: { id: "vapi-call-no-answer" },
      },
    });
    expect(res.statusCode).toBe(200);

    const call = await waitForCallStatus(incidentId, "vapi-call-no-answer", "NO_ANSWER");
    expect(call.ended_reason).toBe("customer-did-not-answer");

    // The escalation service dials the next contact (mock provider in tests).
    await waitFor(async () =>
      (await db.listCallEvents(incidentId)).some(
        (c) => c.recipient_reference === "+910000000002",
      ),
    );

    const recipients = await db.listIncidentRecipients(incidentId);
    const first = recipients.find((r) => r.recipient_reference === "+910000000001");
    expect(first?.delivery_status).toBe("FAILED");
    expect(first?.acknowledged_at).toBeNull();
  });

  it("stores the recording reference and the full transcript from end-of-call-report", async () => {
    const { incidentId } = await seedIncidentAndCall({ callReference: "vapi-call-report" });

    const report = {
      message: {
        type: "end-of-call-report",
        endedReason: "customer-ended-call",
        startedAt: "2026-10-14T09:00:00.000Z",
        endedAt: "2026-10-14T09:02:00.000Z",
        artifact: {
          recordingUrl: "https://storage.vapi.ai/recordings/vapi-call-report.wav",
          transcript: "assistant: Are you safe?\nuser: yes",
        },
        call: { id: "vapi-call-report" },
      },
    };

    const res = await postWebhook(report);
    expect(res.statusCode).toBe(200);

    await waitFor(
      async () =>
        (await db.findCallEventByReference("vapi-call-report"))?.recording_ref !== null,
    );
    const call = await db.findCallEventByReference("vapi-call-report");
    expect(call?.recording_ref).toBe("https://storage.vapi.ai/recordings/vapi-call-report.wav");
    expect(call?.transcript).toContain("Are you safe?");
    expect(call?.ended_at).toBe("2026-10-14T09:02:00.000Z");

    const evidence = await db.listIncidentEvidence(incidentId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("call_recording");
    expect(evidence[0]?.storage_ref).toBe(
      "https://storage.vapi.ai/recordings/vapi-call-report.wav",
    );

    // Duplicate delivery of the same report must not create duplicate evidence.
    const processedBefore = processedCount();
    await postWebhook(report);
    await waitFor(() => processedCount() > processedBefore);
    expect((await db.listIncidentEvidence(incidentId)).length).toBe(1);
  });

  it("appends final transcript segments without duplicating retries", async () => {
    await seedIncidentAndCall({ callReference: "vapi-call-transcript" });

    await postWebhook({
      message: {
        type: "transcript",
        transcriptType: "final",
        role: "assistant",
        transcript: "This is Vapi calling about an SOS.",
        call: { id: "vapi-call-transcript" },
      },
    });
    await waitFor(
      async () =>
        (await db.findCallEventByReference("vapi-call-transcript"))?.transcript !== null,
    );

    await postWebhook({
      message: {
        type: "transcript",
        transcriptType: "final",
        role: "user",
        transcript: "I cannot talk now.",
        call: { id: "vapi-call-transcript" },
      },
    });
    await waitFor(async () =>
      (await db.findCallEventByReference("vapi-call-transcript"))?.transcript?.includes(
        "I cannot talk now.",
      ) === true,
    );

    // Retry of segment two must not duplicate it.
    const processedBefore = processedCount();
    await postWebhook({
      message: {
        type: "transcript",
        transcriptType: "final",
        role: "user",
        transcript: "I cannot talk now.",
        call: { id: "vapi-call-transcript" },
      },
    });
    await waitFor(() => processedCount() > processedBefore);
    const call = await db.findCallEventByReference("vapi-call-transcript");
    expect(call?.transcript).toBe(
      "This is Vapi calling about an SOS.\nI cannot talk now.",
    );
  });

  it("quarantines webhooks for unknown call references", async () => {
    const res = await postWebhook({
      message: {
        type: "status-update",
        status: "ended",
        endedReason: "customer-ended-call",
        call: { id: "not-our-call" },
      },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() =>
      db
        .getAuditLogs()
        .some(
          (e) =>
            e.event_type === "vapi.webhook_unmatched" &&
            (e.event_data as Record<string, unknown>)?.callReference === "not-our-call",
        ),
    );
  });

  it("rejects malformed JSON bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "content-type": "application/json", "x-vapi-signature": "ab".repeat(32) },
      payload: "{not-json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUEST_BODY");
  });

  async function waitForCallStatus(incidentId: string, callReference: string, status: string) {
    await waitFor(
      async () => (await db.findCallEventByReference(callReference))?.status === status,
    );
    const call = await db.findCallEventByReference(callReference);
    if (!call) throw new Error(`call ${callReference} vanished`);
    return call;
  }
});
