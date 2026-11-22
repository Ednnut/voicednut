const REVIEW_ONLY_REASONS = new Set([
  "ambiguous_outbound_outcome",
  "worker_interrupted_requires_review",
]);

function buildCallJobDlqDiagnostic(entry = {}) {
  const jobType = String(entry.job_type || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 64) || "unknown";
  const reason = String(entry.dead_letter_reason || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_")
    .slice(0, 80) || "unknown";
  const isCallJob = ["outbound_call", "callback_call"].includes(jobType);
  const requiresReview = isCallJob || REVIEW_ONLY_REASONS.has(reason);

  return {
    dlq_id: Number(entry.id) || null,
    job_id: Number(entry.job_id) || null,
    job_type: jobType,
    status: String(entry.status || "open").slice(0, 20),
    attempts: Math.max(0, Number(entry.attempts) || 0),
    dead_letter_reason: reason,
    external_outcome: requiresReview ? "unknown" : "not_verified",
    retry_safety: requiresReview ? "blocked_pending_review" : "requires_operator_assessment",
    recommended_next_action: isCallJob
      ? "Check provider state and correlate provider records before any manual resolution."
      : "Review the job details and verify the external outcome before replay.",
    created_at: entry.created_at || null,
    updated_at: entry.updated_at || null,
  };
}

module.exports = { buildCallJobDlqDiagnostic };
