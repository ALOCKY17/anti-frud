"use strict";

const HIGH_VALUE_MINOR_DEFAULT = 100000;

function scorePayment({ failedAttempts, amount, currency = "usd" }) {
  const signals = [];
  let score = 0;
  if (failedAttempts >= 1) {
    score += 35;
    signals.push("At least one payment failure was recorded by Stripe");
  }
  if (failedAttempts >= 2) {
    score += Math.min((failedAttempts - 1) * 25, 50);
    signals.push(`${failedAttempts} failed payment events recorded for this PaymentIntent`);
  }
  const configuredThreshold = Number.parseInt(process.env.HIGH_VALUE_MINOR || "", 10);
  const highValueMinor = Number.isSafeInteger(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold
    : HIGH_VALUE_MINOR_DEFAULT;
  const configuredCurrency = (process.env.HIGH_VALUE_CURRENCY || "usd").toLowerCase();
  const highValueCurrency = /^[a-z]{3}$/.test(configuredCurrency) ? configuredCurrency : "usd";
  if (currency.toLowerCase() === highValueCurrency && amount >= highValueMinor) {
    score += 10;
    signals.push("Amount meets the locally configured high-value review threshold");
  }
  return { risk: Math.min(score, 100), signals };
}

module.exports = { HIGH_VALUE_MINOR_DEFAULT, scorePayment };
