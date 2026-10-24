"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const Stripe = require("stripe");
const { scorePayment } = require("./risk");

const ROOT = __dirname;
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"]
};
const PAYMENT_INTENT_EVENTS = new Set([
  "payment_intent.created",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
  "payment_intent.canceled"
]);

function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payment_intent_id TEXT,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stripe_events_payment_intent
      ON stripe_events(payment_intent_id, event_type);
    CREATE TABLE IF NOT EXISTS payment_cases (
      id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'open'
        CHECK(decision IN ('open', 'reviewed', 'allowed', 'flagged')),
      decision_at INTEGER,
      decline_code TEXT
    );
  `);
  return db;
}

function json(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  const hostname = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function validOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.host) && parsed.host.toLowerCase() === request.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

function shapeCase(row) {
  const scored = scorePayment({ failedAttempts: row.failed_attempts, amount: row.amount, currency: row.currency });
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    failedAttempts: row.failed_attempts,
    decision: row.decision,
    decisionAt: row.decision_at,
    declineCode: row.decline_code,
    risk: scored.risk,
    signals: scored.signals
  };
}

function recordStripeEvent(db, stripeEvent) {
  const object = stripeEvent.data && stripeEvent.data.object;
  const paymentIntentId = object && typeof object.id === "string" && object.id.startsWith("pi_")
    ? object.id
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO stripe_events(event_id, event_type, payment_intent_id, received_at) VALUES (?, ?, ?, ?)"
    );
    const result = insert.run(stripeEvent.id, stripeEvent.type, paymentIntentId, Date.now());
    if (result.changes === 0) {
      db.exec("COMMIT");
      return "duplicate";
    }

    if (PAYMENT_INTENT_EVENTS.has(stripeEvent.type) && paymentIntentId && Number.isSafeInteger(object.amount) &&
        object.amount >= 0 && typeof object.currency === "string" && /^[a-z]{3}$/i.test(object.currency)) {
      const failedAttempts = Number(db.prepare(
        "SELECT COUNT(*) AS total FROM stripe_events WHERE payment_intent_id = ? AND event_type = 'payment_intent.payment_failed'"
      ).get(paymentIntentId).total);
      const createdAt = Number.isSafeInteger(object.created) ? object.created * 1000 : stripeEvent.created * 1000;
      const lastSeen = stripeEvent.created * 1000;
      const paymentStatus = typeof object.status === "string" ? object.status.slice(0, 64) : "unknown";
      const declineCode = object.last_payment_error && typeof object.last_payment_error.code === "string"
        ? object.last_payment_error.code.slice(0, 64)
        : null;
      db.prepare(`
        INSERT INTO payment_cases(id, amount, currency, payment_status, created_at, last_seen, failed_attempts, decline_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          amount = excluded.amount,
          currency = excluded.currency,
          payment_status = CASE WHEN excluded.last_seen >= payment_cases.last_seen
            THEN excluded.payment_status ELSE payment_cases.payment_status END,
          last_seen = MAX(payment_cases.last_seen, excluded.last_seen),
          failed_attempts = excluded.failed_attempts,
          decline_code = CASE WHEN excluded.last_seen >= payment_cases.last_seen
            THEN excluded.decline_code ELSE payment_cases.decline_code END
      `).run(paymentIntentId, object.amount, object.currency.toLowerCase(), paymentStatus, createdAt, lastSeen, failedAttempts, declineCode);
    }
    db.exec("COMMIT");
    return "recorded";
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createServer(options = {}) {
  const databasePath = options.databasePath || path.join(ROOT, "data", "clearline.sqlite");
  const webhookSecret = options.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
  const db = openDatabase(databasePath);
  const stripe = new Stripe("sk_test_local_webhook_verification_only");
  const findCase = db.prepare("SELECT * FROM payment_cases WHERE id = ?");
  const listCases = db.prepare("SELECT * FROM payment_cases ORDER BY last_seen DESC LIMIT 500");
  const updateDecision = db.prepare(
    "UPDATE payment_cases SET decision = ?, decision_at = ? WHERE id = ?"
  );

  async function handle(request, response) {
    const requestUrl = new URL(request.url, "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname === "/webhooks/stripe" && request.method === "POST") {
      if (!webhookSecret) return json(response, 503, { error: "Stripe test webhook secret is not configured." });
      let rawBody;
      try {
        rawBody = await readBody(request);
      } catch (error) {
        if (!response.destroyed && !response.writableEnded) json(response, error.statusCode || 400, { error: error.message });
        return;
      }
      let stripeEvent;
      try {
        stripeEvent = stripe.webhooks.constructEvent(rawBody, request.headers["stripe-signature"], webhookSecret);
      } catch (error) {
        return json(response, 400, { error: "Invalid Stripe webhook signature or payload." });
      }
      if (stripeEvent.livemode) return json(response, 403, { error: "Live-mode events are not accepted by this local test-mode app." });
      try {
        const result = recordStripeEvent(db, stripeEvent);
        return json(response, 200, { received: true, result });
      } catch (error) {
        console.error("Could not store verified Stripe event.", error);
        return json(response, 500, { error: "Could not store the verified Stripe event." });
      }
    }

    if (!isLoopbackHost(request.headers.host)) return json(response, 403, { error: "This app only accepts loopback requests." });
    if (!validOrigin(request)) return json(response, 403, { error: "Cross-origin requests are not allowed." });

    if (pathname === "/api/health" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        environment: "test",
        webhookConfigured: Boolean(webhookSecret),
        storage: "sqlite"
      });
    }

    if (pathname === "/api/cases" && request.method === "GET") {
      return json(response, 200, { cases: listCases.all().map(shapeCase) });
    }

    const decisionMatch = pathname.match(/^\/api\/cases\/(pi_[A-Za-z0-9_]+)\/decision$/);
    if (decisionMatch && request.method === "POST") {
      let body;
      try {
        body = JSON.parse((await readBody(request, 4096)).toString("utf8"));
      } catch (error) {
        return json(response, error.statusCode || 400, { error: "Request must contain valid JSON." });
      }
      const allowedDecisions = new Set(["open", "reviewed", "allowed", "flagged"]);
      if (!body || !allowedDecisions.has(body.decision)) {
        return json(response, 400, { error: "Decision must be open, reviewed, allowed, or flagged." });
      }
      if (!findCase.get(decisionMatch[1])) return json(response, 404, { error: "Payment case not found." });
      updateDecision.run(body.decision, Date.now(), decisionMatch[1]);
      return json(response, 200, { case: shapeCase(findCase.get(decisionMatch[1])) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(response, 404, { error: "Not found." });
    }
    const file = STATIC_FILES[pathname];
    if (!file) return json(response, 404, { error: "Not found." });
    const filePath = path.join(ROOT, file[0]);
    try {
      const content = fs.readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": file[1],
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      console.error(`Could not serve ${filePath}.`, error);
      json(response, 500, { error: "Could not serve the dashboard." });
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("Unhandled request error.", error);
      if (!response.headersSent) json(response, 500, { error: "Internal server error." });
      else response.destroy();
    });
  });
  server.database = db;
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "4242", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a valid TCP port.");
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      console.log(`Clearline listening at http://127.0.0.1:${port} (loopback only; test-mode events only).`);
    });
    const shutdown = () => server.close(() => {
      server.database.close();
      process.exit(0);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}

module.exports = { createServer, recordStripeEvent, shapeCase };
