import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app.jsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function json(data) { return Promise.resolve(new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })); }

describe('entrada da aplicação', () => {
  it('mostra login em uma instalação sem conexão prévia', async () => {
    vi.stubGlobal('fetch', vi.fn((path) => String(path).includes('/health')
      ? json({ credentialsStorageReady: true, torrentGatewayConfigured: false })
      : json({ previouslyConnected: false, sessionAvailable: false })));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Entre para começar' })).toBeInTheDocument();
  });

  it('pula para a busca quando a conexão Nuvio já existe', async () => {
    vi.stubGlobal('fetch', vi.fn((path) => String(path).includes('/health')
      ? json({ credentialsStorageReady: true, torrentGatewayConfigured: false })
      : json({ previouslyConnected: true, sessionAvailable: true, profileId: 1 })));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Encontre algo para assistir.' })).toBeInTheDocument();
  });
});
