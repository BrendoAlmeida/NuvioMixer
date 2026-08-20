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

  it('abre o painel de preload e solicita a preparação local da combinação', async () => {
    window.history.replaceState({}, '', '/combinacoes');
    const mix = {
      id: 'mix-1', label: 'Filme · mix', type: 'movie', updatedAt: '2026-08-18T12:00:00.000Z',
      video: { sourceAddonName: 'Vídeo' }, audio: { sourceAddonName: 'Áudio' }
    };
    vi.stubGlobal('fetch', vi.fn((path, options = {}) => {
      const requestPath = String(path);
      if (requestPath.includes('/health')) return json({ credentialsStorageReady: true, torrentGatewayConfigured: false });
      if (requestPath.includes('/nuvio/connection')) return json({ previouslyConnected: true, sessionAvailable: true, profileId: 1 });
      if (requestPath === '/api/mixes') return json({ mixes: [mix] });
      if (requestPath === '/api/preload-cache') return json({ bytes: 0, mixes: [] });
      if (requestPath === '/api/mixes/mix-1/status') return json({ sessions: { vod: null, hls: null, fmp4: null }, preload: { state: 'idle', running: false, cache: { duration: 100, cachedRanges: [{ startSeconds: 0, endSeconds: 20 }], preparedSegments: 1, totalSegments: 4, bytes: 1024 }, events: [], warnings: [] } });
      if (requestPath === '/api/mixes/mix-1/preload' && options.method === 'POST') return json({ preload: { state: 'indexing', running: true, events: [], warnings: [] } });
      return json({});
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preparar localmente' }));
    expect(await screen.findByRole('heading', { name: 'Pronto antes de abrir no Nuvio' })).toBeInTheDocument();
    expect(screen.getByLabelText('Trechos disponíveis no cache local')).toBeInTheDocument();
    expect(screen.getByText('Cache até')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar preload' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/mixes/mix-1/preload', expect.objectContaining({ method: 'POST' })));
  });
});
