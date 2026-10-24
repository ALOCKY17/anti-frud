"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Stripe = require("stripe");
const { createServer } = require("./server");

const signingSecret = "whsec_local_test_secret";
let counter = 0;

function makeEvent(type, object, livemode = false) {
  counter += 1;
  return {
    id: `evt_local_${counter}`,
    object: "event",
    api_version: "2025-09-30.clover",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type
  };
}

async function withServer(t, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clearline-test-"));
  const server = createServer({ databasePath: path.join(directory, "test.sqlite"), webhookSecret: signingSecret });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return callback(baseUrl);
}

async function sendWebhook(baseUrl, event, secret = signingSecret) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload
  });
}

function requestWithHeaders(baseUrl, route, headers) {
  const target = new URL(route, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    request.on("error", reject);
    request.end();
  });
}

test("health and payment-case endpoints are served locally", async (t) => {
  await withServer(t, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, environment: "test", webhookConfigured: true, storage: "sqlite" });
    const cases = await fetch(`${baseUrl}/api/cases`).then((response) => response.json());
    assert.deepEqual(cases, { cases: [] });
  });
});

test("signed PaymentIntent events persist minimal fields and are idempotent", async (t) => {
  await withServer(t, async (baseUrl) => {
    const paymentIntent = {
      id: "pi_local_123",
      object: "payment_intent",
      amount: 125000,
      amount_received: 0,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Sensitive text must not persist." }
    };
    const failedEvent = makeEvent("payment_intent.payment_failed", paymentIntent);
    const failed = await sendWebhook(baseUrl, failedEvent);
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), { received: true, result: "recorded" });

    const duplicate = await sendWebhook(baseUrl, failedEvent);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { received: true, result: "duplicate" });

    const cases = await fetch(`${baseUrl}/api/cases`).then((response) => response.json());
    assert.equal(cases.cases.length, 1);
    assert.equal(cases.cases[0].id, "pi_local_123");
    assert.equal(cases.cases[0].failedAttempts, 1);
    assert.equal(cases.cases[0].risk, 45);
    assert.equal(cases.cases[0].declineCode, "card_declined");
    assert.equal(JSON.stringify(cases).includes("Sensitive text"), false);

    const succeeded = makeEvent("payment_intent.succeeded", { ...paymentIntent, status: "succeeded" });
    assert.equal((await sendWebhook(baseUrl, succeeded)).status, 200);
    const updated = await fetch(`${baseUrl}/api/cases`).then((response) => response.json());
    assert.equal(updated.cases.length, 1);
    assert.equal(updated.cases[0].paymentStatus, "succeeded");
    assert.equal(updated.cases[0].failedAttempts, 1);
  });
});

test("invalid signatures and live-mode events are rejected", async (t) => {
  await withServer(t, async (baseUrl) => {
    const payload = JSON.stringify(makeEvent("payment_intent.succeeded", {
      id: "pi_local_live",
      amount: 500,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      status: "succeeded"
    }));
    const badSignature = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=invalid" },
      body: payload
    });
    assert.equal(badSignature.status, 400);

    const liveEvent = makeEvent("payment_intent.succeeded", {
      id: "pi_local_live",
      amount: 500,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      status: "succeeded"
    }, true);
    const liveResponse = await sendWebhook(baseUrl, liveEvent);
    assert.equal(liveResponse.status, 403);
    assert.deepEqual(await liveResponse.json(), { error: "Live-mode events are not accepted by this local test-mode app." });

    const cases = await fetch(`${baseUrl}/api/cases`).then((response) => response.json());
    assert.deepEqual(cases, { cases: [] });
  });
});

test("review decisions persist without changing Stripe payment status", async (t) => {
  await withServer(t, async (baseUrl) => {
    const paymentIntent = {
      id: "pi_local_decision",
      amount: 5000,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      status: "succeeded"
    };
    assert.equal((await sendWebhook(baseUrl, makeEvent("payment_intent.succeeded", paymentIntent))).status, 200);

    const response = await fetch(`${baseUrl}/api/cases/pi_local_decision/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "flagged" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.case.decision, "flagged");
    assert.equal(body.case.paymentStatus, "succeeded");

    const invalid = await fetch(`${baseUrl}/api/cases/pi_local_decision/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "refunded" })
    });
    assert.equal(invalid.status, 400);
  });
});

test("dashboard rejects non-loopback hosts and cross-origin API requests", async (t) => {
  await withServer(t, async (baseUrl) => {
    const wrongHost = await requestWithHeaders(baseUrl, "/api/health", { Host: "example.test" });
    assert.equal(wrongHost.statusCode, 403);
    const wrongOrigin = await requestWithHeaders(baseUrl, "/api/health", {
      Host: "127.0.0.1",
      Origin: "http://localhost:1234"
    });
    assert.equal(wrongOrigin.statusCode, 403);
  });
});
