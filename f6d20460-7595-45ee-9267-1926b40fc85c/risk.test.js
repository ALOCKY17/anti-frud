"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scorePayment } = require("./risk");

test("risk score reflects failed payment attempts and the configured amount threshold", () => {
  const original = process.env.HIGH_VALUE_MINOR;
  const originalCurrency = process.env.HIGH_VALUE_CURRENCY;
  process.env.HIGH_VALUE_MINOR = "100000";
  process.env.HIGH_VALUE_CURRENCY = "usd";
  try {
    assert.deepEqual(scorePayment({ failedAttempts: 0, amount: 1000 }), { risk: 0, signals: [] });
    assert.equal(scorePayment({ failedAttempts: 1, amount: 1000 }).risk, 35);
    assert.equal(scorePayment({ failedAttempts: 2, amount: 1000 }).risk, 60);
    assert.equal(scorePayment({ failedAttempts: 3, amount: 100000 }).risk, 95);
    assert.equal(scorePayment({ failedAttempts: 99, amount: 100000 }).risk, 95);
    assert.equal(scorePayment({ failedAttempts: 0, amount: 100000, currency: "eur" }).risk, 0);
    process.env.HIGH_VALUE_CURRENCY = "eur";
    assert.equal(scorePayment({ failedAttempts: 0, amount: 100000, currency: "eur" }).risk, 10);
  } finally {
    if (original === undefined) delete process.env.HIGH_VALUE_MINOR;
    else process.env.HIGH_VALUE_MINOR = original;
    if (originalCurrency === undefined) delete process.env.HIGH_VALUE_CURRENCY;
    else process.env.HIGH_VALUE_CURRENCY = originalCurrency;
  }
});
