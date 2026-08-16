import { randomUUID } from 'node:crypto';

const jobs = new Map();
const maxJobs = 30;
const jobMaxAgeMs = 15 * 60 * 1000;

function publicProvider(provider) {
  return {
    addonId: provider.addonId,
    name: provider.name,
    status: provider.status,
    streams: provider.streams,
    error: provider.error || null,
  };
}

function snapshot(job) {
  return {
    id: job.id,
    videoId: job.videoId,
    type: job.type,
    status: job.status,
    completed: job.completed,
    total: job.providers.length,
    providers: job.providers.map(publicProvider),
  };
}

function emit(job, event, data) {
  for (const listener of job.listeners) listener(event, data);
}

function finish(job) {
  if (job.status === 'cancelled') return;
  job.status = 'complete';
  job.completedAt = Date.now();
  emit(job, 'complete', snapshot(job));
}

async function run(job, getStreams, concurrency) {
  let next = 0;
  async function worker() {
    while (!job.cancelled) {
      const index = next++;
      const provider = job.providers[index];
      if (!provider) return;
      provider.status = 'loading';
      emit(job, 'provider', publicProvider(provider));
      try {
        const streams = await getStreams(provider.addon, job.type, job.videoId);
        if (job.cancelled) return;
        provider.streams = streams;
        provider.status = streams.length ? 'ready' : 'empty';
      } catch (error) {
        if (job.cancelled) return;
        provider.status = 'error';
        provider.error = error instanceof Error ? error.message : 'Falha ao carregar este provedor.';
      }
      job.completed += 1;
      emit(job, 'provider', publicProvider(provider));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, job.providers.length) }, worker));
  finish(job);
}

function cleanup() {
  const expiration = Date.now() - jobMaxAgeMs;
  for (const [id, job] of jobs) if (job.createdAt < expiration && job.listeners.size === 0) jobs.delete(id);
  while (jobs.size > maxJobs) jobs.delete(jobs.keys().next().value);
}

export function createSourceJob({ addons, videoId, type, getStreams, concurrency = 4 }) {
  cleanup();
  const job = {
    id: randomUUID(),
    videoId,
    type,
    status: 'running',
    completed: 0,
    createdAt: Date.now(),
    cancelled: false,
    listeners: new Set(),
    providers: addons.map((addon) => ({ addon, addonId: addon.id, name: addon.name, status: 'pending', streams: [], error: null })),
  };
  jobs.set(job.id, job);
  if (!job.providers.length) finish(job);
  else void run(job, getStreams, concurrency);
  return snapshot(job);
}

export function getSourceJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

export function subscribeSourceJob(id, listener) {
  const job = jobs.get(id);
  if (!job) return null;
  job.listeners.add(listener);
  listener('snapshot', snapshot(job));
  return () => job.listeners.delete(listener);
}

export function cancelSourceJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.cancelled = true;
  job.status = 'cancelled';
  job.completedAt = Date.now();
  emit(job, 'complete', snapshot(job));
  return snapshot(job);
}

export function retryableAddonIds(id) {
  const job = jobs.get(id);
  return job?.providers.filter((provider) => provider.status === 'error').map((provider) => provider.addonId) || [];
}
