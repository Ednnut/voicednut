function formatUsd(value) {
  const amount = Number(value);
  return isFiniteNumber(value) ? `$${amount.toFixed(2)}` : "unknown";
}

function formatCount(value) {
  const count = Number(value);
  return isFiniteNumber(value) && count >= 0 ? String(Math.floor(count)) : "unknown";
}

function formatMinutes(value) {
  const minutes = Number(value);
  return isFiniteNumber(value) && minutes >= 0 ? `${minutes.toFixed(1)} min` : "unknown";
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function formatSpekoUsageMessage(payload = {}) {
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : {};
  const budget = payload?.budget && typeof payload.budget === "object" ? payload.budget : {};
  const month = /^\d{4}-\d{2}$/.test(String(budget.month || "")) ? budget.month : "current month";
  const spend = isFiniteNumber(budget.spend_usd)
    ? budget.spend_usd
    : usage.totalCost;
  const limit = isFiniteNumber(budget.limit_usd) ? budget.limit_usd : null;
  const balance = isFiniteNumber(budget.balance_usd)
    ? budget.balance_usd
    : usage.balanceUsd;
  const budgetStatus = budget.exceeded === true
    ? "Limit reached; new calls are paused"
    : budget.nearing_limit === true
      ? "Near the configured limit"
      : limit === null
        ? "Alert only; no monthly spend limit configured"
        : "Within the configured limit";

  return [
    `📊 Speko usage — ${month}`,
    `Spend: ${formatUsd(spend)}`,
    `Credit balance: ${formatUsd(balance)}`,
    `Monthly limit: ${limit === null ? "not set" : formatUsd(limit)}`,
    `Remaining: ${isFiniteNumber(budget.remaining_usd) ? formatUsd(budget.remaining_usd) : "not set"}`,
    `Calls: ${formatCount(usage.totalSessions)}`,
    `Minutes: ${formatMinutes(usage.totalMinutes)}`,
    `Budget status: ${budgetStatus}`,
  ].join("\n");
}

function formatSpekoMetricsMessage(payload = {}) {
  const periodHours = Number(payload?.period_hours);
  const safePeriodHours = Number.isInteger(periodHours) && periodHours >= 1 && periodHours <= 720
    ? periodHours
    : 24;
  const events = Array.isArray(payload?.calls?.events) ? payload.calls.events : [];
  const lines = [`📈 Speko activity — last ${safePeriodHours} hours`];
  const safeEvents = events.slice(0, 8).map((entry) => {
    const event = String(entry?.event || "unknown")
      .replace(/[^a-zA-Z0-9_.:-]/g, "_")
      .slice(0, 48);
    return { event: event || "unknown", count: formatCount(entry?.count) };
  });

  if (!safeEvents.length) {
    lines.push("No Speko activity recorded in this period.");
  } else {
    lines.push(...safeEvents.map((entry) => `• ${entry.event}: ${entry.count}`));
  }
  return lines.join("\n");
}

module.exports = { formatSpekoMetricsMessage, formatSpekoUsageMessage };
