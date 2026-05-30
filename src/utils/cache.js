export function isFresh(lastFetchAt, ttl, now = Date.now()) {
  return lastFetchAt > 0 && now - lastFetchAt < ttl;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
