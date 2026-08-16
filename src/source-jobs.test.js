import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceJob, getSourceJob, subscribeSourceJob } from './source-jobs.js';

function addon(id) { return { id, name: `Addon ${id}` }; }

test('carrega fontes progressivamente sem ultrapassar o limite de concorrência', async () => {
  const resolvers = [];
  let running = 0;
  let highestConcurrency = 0;
  const getStreams = (_addon, _type, videoId) => new Promise((resolve) => {
    running += 1;
    highestConcurrency = Math.max(highestConcurrency, running);
    resolvers.push(() => { running -= 1; resolve([{ kind: 'url', url: `https://example.test/${videoId}/${resolvers.length}` }]); });
  });
  const job = createSourceJob({ addons: [addon('a'), addon('b'), addon('c')], videoId: 'tt100:1:1', type: 'series', getStreams, concurrency: 2 });
  const events = [];
  const unsubscribe = subscribeSourceJob(job.id, (event, data) => events.push({ event, data }));
  await Promise.resolve();
  assert.equal(highestConcurrency, 2);
  assert.equal(getSourceJob(job.id).completed, 0);
  resolvers.shift()();
  await Promise.resolve();
  assert.equal(highestConcurrency, 2);
  resolvers.shift()();
  await Promise.resolve();
  resolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  for (let attempt = 0; attempt < 5 && getSourceJob(job.id).status !== 'complete'; attempt += 1) await new Promise(setImmediate);
  const complete = getSourceJob(job.id);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.completed, 3);
  assert.equal(complete.videoId, 'tt100:1:1');
  assert.equal(events.filter((item) => item.event === 'provider').length >= 3, true);
  assert.equal(events.some((item) => item.event === 'complete'), true);
  unsubscribe();
});
