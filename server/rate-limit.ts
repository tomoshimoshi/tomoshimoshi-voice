// The worker is deliberately single-instance. Bound both requests and limiter
// memory; this complements platform flood protection, not a distributed quota.
export function createRateLimiter(limit = 180, windowMs = 60000, capacity = 10000) {
  const entries = new Map<string, { count: number; until: number }>();
  return (subject: string, now = Date.now()) => {
    let entry = entries.get(subject);
    if (!entry || entry.until <= now) {
      if (entries.size >= capacity) {
        for (const [key, value] of entries)
          if (value.until <= now) entries.delete(key);
        if (!entries.has(subject) && entries.size >= capacity) return false;
      }
      entry = { count: 0, until: now + windowMs };
      entries.set(subject, entry);
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}
