import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeTestApp,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  type TestApp,
} from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const OTHER = { "x-device-id": VALID_DEVICE_ID_2 };

describe("Contacts CRUD", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function addContact(headers: Record<string, string>, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/contacts", headers, payload });
  }

  function listContacts(headers: Record<string, string>) {
    return app.inject({ method: "GET", url: "/contacts", headers });
  }

  it("creates a contact, normalizes the phone and applies the default priority", async () => {
    const res = await addContact(OWNER, {
      contactName: "  Amma  ",
      phoneNumber: "+91 98765-43210",
    });

    expect(res.statusCode).toBe(201);
    const contact = res.json().contact;
    expect(contact.contactName).toBe("Amma");
    expect(contact.phoneNumber).toBe("+919876543210");
    expect(contact.priority).toBe(10);
    expect(contact.id).toBeTruthy();

    const audit = db
      .getAuditLogs()
      .find((entry) => entry.event_type === "contact.created");
    expect((audit?.event_data as Record<string, unknown>)?.contactId).toBe(contact.id);
  });

  it("lists contacts in the order they will be called", async () => {
    await addContact(OWNER, { contactName: "Second", phoneNumber: "+919000000002", priority: 2 });
    await addContact(OWNER, { contactName: "First", phoneNumber: "+919000000001", priority: 1 });
    await addContact(OWNER, { contactName: "Third", phoneNumber: "+919000000003", priority: 2 });

    const res = await listContacts(OWNER);
    expect(res.statusCode).toBe(200);
    const names = res
      .json()
      .contacts.filter((c: { priority: number }) => c.priority === 1)
      .map((c: { contactName: string }) => c.contactName);
    expect(names).toEqual(["First"]);

    const all = res.json().contacts.map((c: { contactName: string }) => c.contactName);
    expect(all.indexOf("First")).toBeLessThan(all.indexOf("Second"));
    expect(all.indexOf("Second")).toBeLessThan(all.indexOf("Third"));
  });

  it("rejects a duplicate of an already saved number after normalization", async () => {
    const first = await addContact(OWNER, { contactName: "Dupe A", phoneNumber: "+91 98111-22333" });
    expect(first.statusCode).toBe(201);

    const dupe = await addContact(OWNER, { contactName: "Dupe B", phoneNumber: "+919811122333" });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe("CONTACT_EXISTS");
  });

  it("validates the request body", async () => {
    const badPhone = await addContact(OWNER, { contactName: "X", phoneNumber: "abc" });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().error.code).toBe("VALIDATION_ERROR");

    const shortPhone = await addContact(OWNER, { contactName: "X", phoneNumber: "12345" });
    expect(shortPhone.statusCode).toBe(400);

    const emptyName = await addContact(OWNER, { contactName: "   ", phoneNumber: "+919000000009" });
    expect(emptyName.statusCode).toBe(400);

    const badPriority = await addContact(OWNER, {
      contactName: "X",
      phoneNumber: "+919000000009",
      priority: 0,
    });
    expect(badPriority.statusCode).toBe(400);

    const unknownField = await addContact(OWNER, {
      contactName: "X",
      phoneNumber: "+919000000009",
      role: "admin",
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it("deletes a contact and reports unknown ids honestly", async () => {
    const created = await addContact(OWNER, { contactName: "Temp", phoneNumber: "+919000000004" });
    const contactId = created.json().contact.id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/contacts/${contactId}`,
      headers: OWNER,
    });
    expect(deleted.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: `/contacts/${contactId}`,
      headers: OWNER,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("CONTACT_NOT_FOUND");

    const malformed = await app.inject({
      method: "DELETE",
      url: "/contacts/not-a-uuid",
      headers: OWNER,
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().error.code).toBe("CONTACT_NOT_FOUND");
  });

  it("never lets one device see or delete another device's contacts", async () => {
    const created = await addContact(OTHER, { contactName: "Theirs", phoneNumber: "+919000000005" });
    const contactId = created.json().contact.id;

    const mine = await listContacts(OWNER);
    expect(
      mine.json().contacts.find((c: { id: string }) => c.id === contactId),
    ).toBeUndefined();

    const attempt = await app.inject({
      method: "DELETE",
      url: `/contacts/${contactId}`,
      headers: OWNER,
    });
    expect(attempt.statusCode).toBe(404);
    expect(attempt.json().error.code).toBe("CONTACT_NOT_FOUND");
  });

  it("feeds the escalation chain with the normalized number", async () => {
    // A fresh app: the SOS chain calls contacts by priority, and earlier tests
    // left their own contacts behind in the shared database.
    const chain = makeTestApp();
    await chain.app.ready();

    const created = await chain.app.inject({
      method: "POST",
      url: "/contacts",
      headers: OWNER,
      payload: { contactName: "Chain Target", phoneNumber: "+91 90000-00007", priority: 1 },
    });
    expect(created.statusCode).toBe(201);

    const sos = await chain.app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: {
        triggerType: "button",
        latitude: 28.6139,
        longitude: 77.209,
        locationAccuracy: 10,
        deviceTimestamp: new Date().toISOString(),
        clientRequestId: "contacts-chain-1",
      },
    });
    expect(sos.statusCode).toBe(201);
    const incidentId = sos.json().incident.id;

    await waitFor(async () => (await chain.db.listCallEvents(incidentId)).length === 1);
    const [call] = await chain.db.listCallEvents(incidentId);
    expect(call?.recipient_reference).toBe("+919000000007");
    expect(call?.level).toBe(1);
    expect(call?.status).toBe("ANSWERED"); // default mock outcome

    await chain.app.close();
  });
});
