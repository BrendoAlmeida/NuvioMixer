import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('salva a chave do Torbox e atualiza a disponibilidade de torrents', async () => {
    window.history.replaceState({}, '', '/configuracoes');
    let healthCalls = 0;
    vi.stubGlobal('fetch', vi.fn((path) => {
      const requestPath = String(path);
      if (requestPath.includes('/health')) {
        healthCalls += 1;
        return json({ credentialsStorageReady: true, torrentGatewayConfigured: false, torboxConfigured: healthCalls > 1, torrentSourceAvailable: healthCalls > 1 });
      }
      if (requestPath.includes('/nuvio/connection')) return json({ previouslyConnected: true, sessionAvailable: true, profileId: 1 });
      if (requestPath === '/api/addons') return json({ addons: [] });
      if (requestPath === '/api/debrid/torbox') return Promise.resolve(new Response(null, { status: 204 }));
      return json({});
    }));
    render(<App />);
    const input = await screen.findByLabelText('Chave de API do Torbox');
    fireEvent.change(input, { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar chave Torbox' }));
    await waitFor(() => expect(screen.getByText('Configurada')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/debrid/torbox', expect.objectContaining({ method: 'POST' }));
  });
});
