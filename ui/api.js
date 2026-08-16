export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Falha HTTP ${response.status}`);
  return payload;
}

export function sourceEvents(jobId, handlers) {
  const events = new EventSource(`/api/source-searches/${encodeURIComponent(jobId)}/events`);
  for (const name of ['snapshot', 'provider', 'complete']) {
    events.addEventListener(name, (event) => handlers[name]?.(JSON.parse(event.data)));
  }
  events.onerror = () => handlers.error?.();
  return events;
}
