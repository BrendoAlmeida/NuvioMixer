import test from 'node:test';
import assert from 'node:assert/strict';
import { connectNuvio, sourceDisplayName } from './stremio.js';

test('mostra o rótulo da stream escolhida em vez do addon intermediário', () => {
  assert.equal(sourceDisplayName({ sourceName: 'Comet 2160p', sourceAddonName: 'Comet | ElfHosted | TB' }), 'Comet 2160p');
  assert.equal(sourceDisplayName({ name: 'RedeFlix Português', sourceAddonName: 'FrostStream' }), 'RedeFlix Português');
  assert.equal(sourceDisplayName({ sourceAddonName: 'FrostStream' }), 'FrostStream');
});

test('conecta ao Nuvio usando a chave publishable descoberta e carrega perfis', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/.well-known/nuvio')) return Response.json({ version: 1, service: 'nuvio', self_hosted: true, backend_url: 'https://nuvio.test', publishable_key: 'public-key', capabilities: { email_password_auth: true, tv_login: true } });
    if (String(url).includes('/auth/v1/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh' });
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'user-id' });
    if (String(url).endsWith('/rest/v1/rpc/sync_pull_profiles')) return Response.json([{ profile_index: 1, name: 'Principal' }, { profile_index: 2, name: 'Kids' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const connection = await connectNuvio({ apiBase: 'https://nuvio.test', email: 'user@example.test', password: 'secret' });
    assert.equal(connection.publishableKey, 'public-key');
    assert.deepEqual(connection.profiles, [{ profileId: 1, name: 'Principal' }, { profileId: 2, name: 'Kids' }]);
    assert.equal(requests[1].options.headers.apikey, 'public-key');
    assert.equal(requests[2].options.headers.authorization, 'Bearer access');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
