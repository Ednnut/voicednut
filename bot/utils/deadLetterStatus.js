function normalizeLabel(value, fallback, maxLength) {
    const normalized = String(value || fallback)
        .replace(/[^a-z0-9_]+/gi, '_')
        .slice(0, maxLength);
    return normalized || fallback;
}

function getDeadLetterStatusFields(entry = {}) {
    const rawId = String(entry.id ?? 'unknown');
    const id = /^\d{1,12}$/.test(rawId) ? rawId : 'unknown';
    return {
        id,
        jobType: normalizeLabel(entry.job_type, 'unknown', 40),
        reason: normalizeLabel(entry.dead_letter_reason, 'requires_review', 60),
    };
}

module.exports = { getDeadLetterStatusFields };
