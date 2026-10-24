"use strict";

const $ = (selector) => document.querySelector(selector);
const statusLabels = { open: "Open", reviewed: "Reviewed", allowed: "Allowed", flagged: "Flagged" };
let cases = [];
let toastTimer;
let activeCaseId = null;
let refreshGeneration = 0;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function riskLabels(score) {
  return score >= 65 ? "high" : score >= 30 ? "medium" : "low";
}

function displayAmount(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

function displayTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

async function refreshData() {
  const generation = ++refreshGeneration;
  $("#connection-status").textContent = "Updating from local API…";
  try {
    const [healthResponse, casesResponse] = await Promise.all([
      fetch("/api/health", { cache: "no-store" }),
      fetch("/api/cases", { cache: "no-store" })
    ]);
    if (!healthResponse.ok || !casesResponse.ok) throw new Error("The local API returned an error.");
    const health = await healthResponse.json();
    const result = await casesResponse.json();
    if (generation !== refreshGeneration) return;
    cases = result.cases;
    $("#connection-status").textContent = health.webhookConfigured
      ? `Connected · Stripe test webhooks ${health.environment === "test" ? "configured" : "not configured"}`
      : "Connected · set STRIPE_WEBHOOK_SECRET to receive webhooks";
    render();
  } catch (error) {
    if (generation !== refreshGeneration) return;
    console.error("Could not load Clearline cases.", error);
    cases = [];
    $("#connection-status").textContent = "API unavailable · start the local server";
    render();
    showToast("Cannot reach the local Clearline API. Start the server and refresh.");
  }
}

function getVisibleCases() {
  const query = $("#search-input").value.trim().toLowerCase();
  const risk = $("#risk-filter").value;
  const status = $("#status-filter").value;
  return cases.filter((item) => {
    const matchesQuery = !query || item.id.toLowerCase().includes(query);
    const matchesRisk = risk === "all" || riskLabels(item.risk) === risk;
    const matchesStatus = status === "all" || item.decision === status;
    return matchesQuery && matchesRisk && matchesStatus;
  });
}

function render() {
  renderMetrics();
  renderCases();
  renderQueue();
}

function renderMetrics() {
  const openCases = cases.filter((item) => item.decision === "open");
  $("#metric-total").textContent = cases.length;
  $("#metric-review").textContent = openCases.length;
  $("#metric-high").textContent = openCases.filter((item) => riskLabels(item.risk) === "high").length;
  $("#metric-reviewed").textContent = cases.filter((item) => item.decision !== "open").length;
  $("#nav-open-count").textContent = openCases.length;
}

function renderCases() {
  const visible = getVisibleCases();
  $("#empty-state").hidden = visible.length > 0;
  $("#events-table").innerHTML = visible.map((item, index) => {
    const risk = riskLabels(item.risk);
    const description = item.signals.length ? item.signals[0] : "No review signals";
    return `<tr>
      <td><div class="customer-cell"><span class="customer-avatar avatar-${index % 4}">PI</span><span class="customer-info"><strong>${escapeHtml(item.id)}</strong><small>PaymentIntent · ${escapeHtml(displayTime(item.lastSeen))}</small></span></div></td>
      <td class="amount-cell">${escapeHtml(displayAmount(item.amount, item.currency))}</td>
      <td><span class="risk-badge risk-${risk}">${risk[0].toUpperCase()}${risk.slice(1)} · ${item.risk}</span></td>
      <td class="signal-cell" title="${escapeHtml(item.signals.join("; "))}">${escapeHtml(description)}</td>
      <td><span class="status-badge status-${item.decision}">${statusLabels[item.decision]}</span></td>
      <td><button class="icon-button row-menu" data-open-case="${escapeHtml(item.id)}" aria-label="Review ${escapeHtml(item.id)}" title="Review payment">···</button></td>
    </tr>`;
  }).join("");
  $("#result-count").textContent = `Showing ${visible.length} of ${cases.length} payment cases`;
}

function renderQueue() {
  const queue = cases.filter((item) => item.decision === "open" && item.risk >= 30).sort((a, b) => b.risk - a.risk);
  $("#queue-number").textContent = queue.length;
  $("#review-queue-button").disabled = queue.length === 0;
  $("#queue-list").innerHTML = queue.length
    ? queue.slice(0, 3).map((item) => `<button class="queue-item" data-open-case="${escapeHtml(item.id)}">
        <span class="queue-dot ${riskLabels(item.risk)}"></span>
        <span class="queue-item-copy"><span class="queue-item-name">${escapeHtml(item.id)}</span><span class="queue-item-meta">${escapeHtml(displayAmount(item.amount, item.currency))} · ${item.failedAttempts} failed</span></span>
        <span class="queue-score">${item.risk}</span>
      </button>`).join("")
    : '<div class="queue-empty">No open payment cases meet the local review threshold.</div>';
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function openCase(id) {
  const item = cases.find((entry) => entry.id === id);
  if (!item) return;
  activeCaseId = item.id;
  const risk = riskLabels(item.risk);
  $("#dialog-title").textContent = `Payment ${item.id}`;
  $("#dialog-content").innerHTML = `<div class="dialog-body">
    <div class="dialog-person"><span class="customer-avatar">PI</span><span class="customer-info"><strong>${escapeHtml(item.id)}</strong><small>Stripe PaymentIntent</small></span><span class="risk-badge risk-${risk}">${risk[0].toUpperCase()}${risk.slice(1)} · ${item.risk}</span></div>
    <div class="dialog-score-row"><span class="score-label">Illustrative review score <span>(0–100)</span></span><strong class="score-value">${item.risk}<span style="color:#a0aab8;font-size:11px"> / 100</span></strong></div>
    <div class="detail-grid">
      <div class="detail-item"><span>Amount</span><strong>${escapeHtml(displayAmount(item.amount, item.currency))}</strong></div>
      <div class="detail-item"><span>Stripe payment status</span><strong>${escapeHtml(item.paymentStatus)}</strong></div>
      <div class="detail-item"><span>Failed payment events</span><strong>${item.failedAttempts}</strong></div>
      <div class="detail-item"><span>Latest event received</span><strong>${escapeHtml(displayTime(item.lastSeen))}</strong></div>
      <div class="detail-item"><span>Created by Stripe</span><strong>${escapeHtml(displayTime(item.createdAt))}</strong></div>
      <div class="detail-item"><span>Local review status</span><strong>${statusLabels[item.decision]}</strong></div>
      ${item.declineCode ? `<div class="detail-item"><span>Processor decline code</span><strong>${escapeHtml(item.declineCode)}</strong></div>` : ""}
    </div>
    <h3 class="signals-heading">Review signals</h3>
    <ul class="signal-list">${item.signals.length ? item.signals.map((signal) => `<li>${escapeHtml(signal)}</li>`).join("") : "<li>No configured review signals were triggered.</li>"}</ul>
    <div class="decision-note">This score is a local, illustrative heuristic—not a fraud finding or a payment decision. Review actions are recorded only in Clearline and do not authorize, cancel, refund, or block the Stripe payment.</div>
  </div>`;
  $("#dialog-actions").innerHTML = item.decision === "open"
    ? `<button class="button button-danger" data-decision="flagged">Flag for follow-up</button><button class="button button-allow" data-decision="allowed">Mark reviewed · low concern</button><button class="button button-primary" data-decision="reviewed">Keep in review</button>`
    : `<button class="button button-secondary" data-decision="open">Reopen for review</button><button class="button button-secondary" id="dialog-done">Done</button>`;
  $("#event-dialog").showModal();
}

async function recordDecision(decision) {
  if (!activeCaseId) return;
  try {
    const response = await fetch(`/api/cases/${encodeURIComponent(activeCaseId)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "The decision could not be saved.");
    }
    $("#event-dialog").close();
    showToast(decision === "open" ? "Payment case reopened." : `Local review marked ${statusLabels[decision].toLowerCase()}.`);
    await refreshData();
  } catch (error) {
    console.error("Could not save Clearline review decision.", error);
    showToast(error.message || "Could not save review decision.");
  }
}

function openNextInQueue() {
  const next = cases.filter((item) => item.decision === "open" && item.risk >= 30).sort((a, b) => b.risk - a.risk)[0];
  if (next) openCase(next.id);
}

$("#current-date").textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date());
$("#page-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase();
$("#search-input").addEventListener("input", renderCases);
$("#risk-filter").addEventListener("change", renderCases);
$("#status-filter").addEventListener("change", renderCases);
$("#events-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-case]");
  if (button) openCase(button.dataset.openCase);
});
$("#queue-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-case]");
  if (button) openCase(button.dataset.openCase);
});
$("#review-queue-button").addEventListener("click", openNextInQueue);
$("#view-all-button").addEventListener("click", () => {
  $("#search-input").value = "";
  $("#risk-filter").value = "all";
  $("#status-filter").value = "all";
  renderCases();
  $("#events").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#refresh-button").addEventListener("click", refreshData);
$("#close-dialog").addEventListener("click", () => $("#event-dialog").close());
$("#dialog-actions").addEventListener("click", (event) => {
  const decision = event.target.closest("[data-decision]");
  if (decision) recordDecision(decision.dataset.decision);
  if (event.target.closest("#dialog-done")) $("#event-dialog").close();
});
$("#event-dialog").addEventListener("click", (event) => {
  if (event.target === $("#event-dialog")) $("#event-dialog").close();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#event-dialog").open) $("#event-dialog").close();
});
refreshData();
