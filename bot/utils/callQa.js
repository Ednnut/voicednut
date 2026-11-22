function formatCallQaLines(qa) {
    if (!qa || typeof qa !== 'object' || Array.isArray(qa)) return [];
    const lines = ['🎯 *Quality review*'];
    const status = qa.status === 'insufficient_transcript'
        ? 'Insufficient transcript'
        : qa.status === 'scored'
            ? (qa.passed === true ? 'Passed' : 'Review needed')
            : 'Status unavailable';
    const score = Number(qa.score);
    const scoreLabel = qa.score !== null && qa.score !== undefined && qa.score !== '' &&
        Number.isFinite(score) && score >= 0 && score <= 100
        ? `${Math.round(score)}/100`
        : status;
    lines.push(`${scoreLabel} · ${status}${qa.shadow_mode === true ? ' · shadow mode' : ''}`);

    const componentScores = qa.metrics?.component_scores;
    if (componentScores && typeof componentScores === 'object' && !Array.isArray(componentScores)) {
        const components = ['compliance', 'resolution', 'empathy', 'clarity']
            .filter((key) => componentScores[key] !== null && componentScores[key] !== undefined &&
                componentScores[key] !== '' && Number.isFinite(Number(componentScores[key])) &&
                Number(componentScores[key]) >= 0 && Number(componentScores[key]) <= 100)
            .map((key) => `${key}: ${Math.round(Number(componentScores[key]))}`);
        if (components.length) lines.push(`Scores: ${components.join(' · ')}`);
    }

    const formatCodes = (value) => Array.isArray(value)
        ? value.slice(0, 3)
            .map((entry) => String(entry || '').trim().toLowerCase())
            .filter((entry) => /^[a-z0-9_]{1,64}$/.test(entry))
            .map((entry) => entry.replace(/_/g, ' '))
        : [];
    const findings = formatCodes(qa.findings);
    if (findings.length) lines.push(`Findings: ${findings.join(', ')}`);
    const recommendations = formatCodes(qa.recommendations);
    if (recommendations.length) lines.push(`Suggestions: ${recommendations.join(', ')}`);
    return lines;
}

module.exports = { formatCallQaLines };
