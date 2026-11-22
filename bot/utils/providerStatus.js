function getProviderStatusFields(providers = {}, limit = 6) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return [];
  }

  const maxRows = Math.max(1, Math.min(12, Number(limit) || 6));
  return Object.entries(providers)
    .map(([rawName, value]) => {
      const name = String(rawName || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .slice(0, 32);
      if (!name) return null;
      const provider = value && typeof value === "object" ? value : {};
      const circuitState = ["closed", "open", "half_open"].includes(
        String(provider.circuit_state || "").toLowerCase(),
      )
        ? String(provider.circuit_state).toLowerCase()
        : "unknown";
      const rawScore = Number(provider.health_score);
      const hasObservedHealth = Boolean(
        provider.last_success_at || provider.last_error_at,
      );
      return {
        name,
        configured: provider.configured === true,
        degraded: provider.degraded === true || circuitState === "open",
        circuitState,
        healthScore:
          hasObservedHealth && Number.isFinite(rawScore)
            ? Math.max(0, Math.min(100, Math.round(rawScore)))
            : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxRows);
}

module.exports = { getProviderStatusFields };
