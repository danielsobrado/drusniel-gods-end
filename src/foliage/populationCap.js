// Optional cap is shared across all variants, after deterministic generation.
export function resolvePopulationCap(value, quality) {
  const cap = typeof value === 'object' && value !== null ? value[quality] : value;
  return Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : undefined;
}

export function comparePopulation(a, b, origin) {
  if (origin) {
    const da = (a.x - origin.x) ** 2 + (a.z - origin.z) ** 2;
    const db = (b.x - origin.x) ** 2 + (b.z - origin.z) ** 2;
    if (da !== db) return da - db;
  }
  const id = String(a.id ?? '').localeCompare(String(b.id ?? ''));
  if (id) return id;
  return (a.x - b.x) || (a.z - b.z) || (a.variant ?? 0) - (b.variant ?? 0);
}

export function capPopulation(records, cap, origin) {
  if (!Number.isFinite(cap)) return records;
  if (origin) records.sort((a, b) => comparePopulation(a, b, origin));
  records.length = Math.min(records.length, Math.max(0, cap));
  return records;
}
