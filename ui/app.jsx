import { useEffect, useMemo, useRef, useState } from 'react';
import { api, sourceEvents } from './api.js';

const sourceKinds = { url: 'Link direto', torrent: 'Torrent' };

function routeFromLocation() {
  return { pathname: window.location.pathname, query: new URLSearchParams(window.location.search) };
}

function useRoute() {
  const [route, setRoute] = useState(routeFromLocation);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  function navigate(to, replace = false) {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
    setRoute(routeFromLocation());
  }
  return [route, navigate];
}

function classNames(...names) { return names.filter(Boolean).join(' '); }
function formatDate(value) { return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(value)) : ''; }
function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}
function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || !bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Number(bytes)) / Math.log(1024)));
  return `${(Number(bytes) / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatTransferRate(bytesPerSecond) { return Number(bytesPerSecond) > 0 ? `${formatBytes(bytesPerSecond)}/s` : 'Calculando…'; }
function toastText(error) { return error instanceof Error ? error.message : 'Algo não saiu como esperado.'; }
function mediaPath(type, contentId, videoId, title = '') { return `/fontes/${type}/${encodeURIComponent(contentId)}?videoId=${encodeURIComponent(videoId)}&title=${encodeURIComponent(title)}`; }
function sameSource(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === 'torrent' ? left.infoHash === right.infoHash && left.fileIdx === right.fileIdx : left.url === right.url;
}

function Logo() { return <span className="logo-mark" aria-hidden="true"><i /><i /></span>; }

function AppShell({ children, route, navigate, connection, health, onToast }) {
  const active = route.pathname.startsWith('/buscar') ? 'buscar' : route.pathname.startsWith('/combinacoes') ? 'combinacoes' : route.pathname.startsWith('/configuracoes') ? 'configuracoes' : '';
  const manifest = `${window.location.origin}/manifest.json`;
  async function copyManifest() {
    try { await navigator.clipboard.writeText(manifest); onToast('URL do addon copiada.'); }
    catch { onToast('Copie a URL exibida em Configurações.'); }
  }
  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate('/buscar')} aria-label="Ir para busca"><Logo /><span>Nuvio<span className="brand-accent">Mixer</span></span></button>
      <nav aria-label="Navegação principal">
        <button className={classNames(active === 'buscar' && 'active')} onClick={() => navigate('/buscar')}>Buscar</button>
        <button className={classNames(active === 'combinacoes' && 'active')} onClick={() => navigate('/combinacoes')}>Combinações</button>
        <button className={classNames(active === 'configuracoes' && 'active')} onClick={() => navigate('/configuracoes')}>Configurações</button>
      </nav>
      <div className="topbar-actions">
        {!health.credentialsStorageReady && <span className="status-chip warning">MASTER_KEY ausente</span>}
        <button className="connection-chip" onClick={() => navigate('/configuracoes')} title="Abrir configuração da conta">
          <span className="connection-dot" />{connection?.sessionAvailable ? 'Nuvio conectado' : 'Sessão indisponível'}
        </button>
        <button className="icon-button" onClick={copyManifest} title="Copiar URL do addon" aria-label="Copiar URL do addon">⧉</button>
      </div>
    </header>
    {children}
  </div>;
}

function LoadingScreen() { return <main className="loading-screen"><Logo /><p>Preparando seu espaço de mixagem…</p></main>; }

function LoginPage({ health, onConnected, onToast }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiBase, setApiBase] = useState('https://api.nuvio.tv');
  const [pending, setPending] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await api('/api/nuvio/connect', { method: 'POST', body: JSON.stringify({ email, password, apiBase }) });
      setPassword('');
      onConnected({ previouslyConnected: true, sessionAvailable: true, profileId: result.profileId, updatedAt: new Date().toISOString(), apiBase: result.apiBase });
      onToast(result.importError || `${result.imported} addon${result.imported === 1 ? '' : 's'} sincronizado${result.imported === 1 ? '' : 's'}.`);
    } catch (error) { onToast(toastText(error)); }
    finally { setPending(false); }
  }
  return <main className="auth-page">
    <section className="auth-visual" aria-hidden="true"><div className="orb orb-one" /><div className="orb orb-two" /><div className="auth-brand"><Logo /><strong>Nuvio<span>Mixer</span></strong><p>Monte a combinação certa,<br />sem alterar a qualidade.</p></div></section>
    <section className="auth-panel">
      <div className="auth-card">
        <span className="eyebrow">CONTA NUVIO</span>
        <h1>Entre para começar</h1>
        <p className="muted">Usamos sua conta para localizar os addons e provedores que você já configurou.</p>
        {!health.credentialsStorageReady && <div className="callout danger"><strong>Falta uma chave de segurança</strong><span>Defina <code>MASTER_KEY</code> no arquivo <code>.env</code> antes de conectar a conta.</span></div>}
        <form className="auth-form" onSubmit={submit}>
          <label>Servidor Nuvio<input type="url" value={apiBase} onChange={(event) => setApiBase(event.target.value)} required /></label>
          <label>E-mail<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" required /></label>
          <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha Nuvio" required /></label>
          <button className="primary wide" disabled={pending || !health.credentialsStorageReady}>{pending ? 'Conectando…' : 'Entrar no Nuvio'} <span aria-hidden="true">→</span></button>
        </form>
        <p className="security-note">Sua senha não é armazenada. A sessão renovável fica cifrada somente no seu volume Docker.</p>
      </div>
    </section>
  </main>;
}

function SearchPage({ navigate }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('movie');
  const [metas, setMetas] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  async function search(event) {
    event?.preventDefault();
    if (!query.trim()) return;
    setStatus('loading'); setError('');
    try { const result = await api(`/api/catalog/search?q=${encodeURIComponent(query.trim())}&type=${type}`); setMetas(result.metas); setStatus('ready'); }
    catch (requestError) { setError(toastText(requestError)); setStatus('error'); }
  }
  useEffect(() => { if (query.trim()) void search(); }, [type]); // O tipo é um filtro explícito da busca atual.
  return <main className="page search-page">
    <section className="page-heading"><span className="eyebrow">CRIAR NOVA COMBINAÇÃO</span><h1>Encontre algo para assistir.</h1><p>Busque um filme ou série. Depois escolha uma fonte para o vídeo e outra para o áudio.</p></section>
    <form className="search-bar" onSubmit={search}><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Busque por títulos, filmes ou séries" aria-label="Buscar título" /><button className="primary" disabled={status === 'loading'}>{status === 'loading' ? 'Buscando…' : 'Buscar'}</button></form>
    <div className="filter-row" role="group" aria-label="Tipo de conteúdo"><span>Mostrar</span>{[['movie', 'Filmes'], ['series', 'Séries']].map(([value, label]) => <button key={value} type="button" className={classNames('filter-chip', type === value && 'selected')} onClick={() => setType(value)}>{label}</button>)}</div>
    {status === 'loading' && <ResultSkeletons />}
    {status === 'error' && <EmptyState title="Não foi possível buscar" body={error} action="Tentar novamente" onAction={search} />}
    {status === 'ready' && !metas.length && <EmptyState title="Nenhum resultado encontrado" body="Tente outro nome ou altere o filtro de tipo." />}
    {status === 'ready' && metas.length > 0 && <section className="media-grid" aria-label="Resultados da busca">{metas.map((meta) => <button className="media-card" key={meta.id} onClick={() => navigate(`/titulo/${meta.type}/${encodeURIComponent(meta.id)}`)}><Poster src={meta.poster} title={meta.name} /><span className="media-type">{meta.type === 'movie' ? 'FILME' : 'SÉRIE'}</span><strong>{meta.name}</strong><small>{meta.year || 'Ano indisponível'}</small></button>)}</section>}
    {status === 'idle' && <section className="search-blank"><span>◌</span><h2>O que vamos combinar hoje?</h2><p>Resultados virão dos metadados públicos; as fontes continuam sendo consultadas apenas nos seus addons.</p></section>}
  </main>;
}

function DetailPage({ route, navigate, onToast }) {
  const [, , type, encodedId] = route.pathname.split('/');
  const contentType = type === 'series' ? 'series' : 'movie';
  const contentId = decodeURIComponent(encodedId || '');
  const [meta, setMeta] = useState(null);
  const [season, setSeason] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setMeta(null); setError('');
    api(`/api/catalog/${contentType}/${encodeURIComponent(contentId)}`).then((result) => { if (current) { setMeta(result.meta); setSeason(result.meta.seasons?.[0]?.number ?? null); } }).catch((requestError) => current && setError(toastText(requestError)));
    return () => { current = false; };
  }, [contentId, contentType]);
  if (error) return <main className="page"><EmptyState title="Não foi possível abrir este título" body={error} action="Voltar à busca" onAction={() => navigate('/buscar')} /></main>;
  if (!meta) return <main className="page"><DetailSkeleton /></main>;
  const selectedSeason = meta.seasons?.find((item) => item.number === season) || meta.seasons?.[0];
  return <main className="detail-page">
    <section className="hero" style={meta.background ? { '--hero-image': `url("${meta.background}")` } : undefined}><div className="hero-shade" /><button className="back-link" onClick={() => navigate('/buscar')}>← Voltar à busca</button><div className="hero-content"><span className="eyebrow">{meta.type === 'series' ? 'SÉRIE' : 'FILME'} {meta.year ? `• ${meta.year}` : ''}</span><h1>{meta.name}</h1><p>{meta.description || 'Descrição indisponível.'}</p><div className="tag-row">{meta.genres?.slice(0, 4).map((genre) => <span key={genre}>{genre}</span>)}</div>{contentType === 'movie' && <button className="primary hero-action" onClick={() => navigate(mediaPath('movie', meta.id, meta.videoId, meta.name))}>Escolher fontes <span>→</span></button>}</div></section>
    {contentType === 'series' && <section className="episodes-area"><div className="section-title"><div><span className="eyebrow">ESCOLHA O EPISÓDIO</span><h2>{meta.name}</h2></div><span className="muted">{meta.seasons?.reduce((sum, item) => sum + item.episodes.length, 0) || 0} episódios</span></div><div className="season-tabs" role="tablist" aria-label="Temporadas">{meta.seasons?.map((item) => <button key={item.number} role="tab" aria-selected={item.number === selectedSeason?.number} className={classNames(item.number === selectedSeason?.number && 'selected')} onClick={() => setSeason(item.number)}>T{item.number === 0 ? 'emporada especial' : `emporada ${item.number}`}</button>)}</div><div className="episode-grid">{selectedSeason?.episodes.map((episode) => <article key={episode.id} className="episode-card"><Poster src={episode.thumbnail} title={episode.name} compact /><div><span className="episode-number">EP. {episode.episode}</span><h3>{episode.name}</h3><p>{episode.description || 'Episódio sem sinopse disponível.'}</p><button className="text-action" onClick={() => navigate(mediaPath('series', meta.id, episode.id, `${meta.name} · T${selectedSeason.number} E${episode.episode}`))}>Escolher fontes <span>→</span></button></div></article>)}</div>{!selectedSeason?.episodes.length && <EmptyState title="Esta temporada não tem episódios disponíveis" body="Tente selecionar outra temporada." />}</section>}
  </main>;
}

function SourcePage({ route, navigate, health, onToast }) {
  const [, , type, encodedContentId] = route.pathname.split('/');
  const contentId = decodeURIComponent(encodedContentId || '');
  const videoId = route.query.get('videoId') || contentId;
  const title = route.query.get('title') || 'Combinação sem nome';
  const [job, setJob] = useState(null);
  const [eventError, setEventError] = useState('');
  const [visibleProviders, setVisibleProviders] = useState(new Set());
  const [video, setVideo] = useState(null);
  const [audio, setAudio] = useState(null);
  const [label, setLabel] = useState(`${title} · mix`);
  const [offset, setOffset] = useState(0);
  const [preflight, setPreflight] = useState(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const jobId = useRef(null);
  const streamRef = useRef(null);
  function applyProvider(provider) { setJob((current) => current ? { ...current, providers: current.providers.map((item) => item.addonId === provider.addonId ? provider : item) } : current); }
  function connectToJob(nextJob) {
    streamRef.current?.close();
    jobId.current = nextJob.id;
    setJob(nextJob); setEventError('');
    const stream = sourceEvents(nextJob.id, { snapshot: setJob, provider: applyProvider, complete: setJob, error: () => setEventError('A atualização ao vivo foi interrompida. Você pode tentar as fontes que já carregaram.') });
    streamRef.current = stream;
    return stream;
  }
  useEffect(() => {
    let stream;
    let live = true;
    api('/api/source-searches', { method: 'POST', body: JSON.stringify({ type, videoId }) }).then(({ job: nextJob }) => { if (live) stream = connectToJob(nextJob); }).catch((error) => live && setEventError(toastText(error)));
    return () => { live = false; stream?.close(); streamRef.current?.close(); if (jobId.current) void api(`/api/source-searches/${jobId.current}`, { method: 'DELETE' }).catch(() => {}); };
  }, [type, videoId]);
  useEffect(() => { if (job?.providers) setVisibleProviders((current) => current.size ? current : new Set(job.providers.map((provider) => provider.addonId))); }, [job?.providers]);
  const providers = job?.providers || [];
  const ready = providers.filter((provider) => provider.status === 'ready');
  const hasSelections = Boolean(video && audio);
  async function retryFailed() {
    if (!job) return;
    try { const result = await api(`/api/source-searches/${job.id}/retry`, { method: 'POST' }); setVideo(null); setAudio(null); setPreflight(null); connectToJob(result.job); }
    catch (error) { onToast(toastText(error)); }
  }
  async function validate() {
    if (!hasSelections) return;
    setPreflight({ status: 'loading' });
    try {
      const result = await api('/api/preflight', { method: 'POST', body: JSON.stringify({ contentId, videoId, type, video, audio, audioOffsetSeconds: Number(offset) }) });
      if (result.sources) { setVideo(result.sources.video); setAudio(result.sources.audio); }
      setPreflight({ status: 'success', duration: result.duration, durationDriftSeconds: result.durationDriftSeconds });
    }
    catch (error) { setPreflight({ status: 'error', message: toastText(error) }); }
  }
  async function save() {
    if (!hasSelections) return;
    setSaving(true);
    try {
      await api('/api/mixes', { method: 'POST', body: JSON.stringify({ label, contentId, videoId, type, scope: type === 'series' ? 'series' : 'single', audioOffsetSeconds: Number(offset), video, audio }) });
      onToast(type === 'series' ? 'Modelo de série salvo. O addon encontrará os episódios compatíveis automaticamente.' : 'Combinação salva. Ela já está disponível no addon.');
      navigate('/combinacoes');
    }
    catch (error) { onToast(toastText(error)); }
    finally { setSaving(false); }
  }
  const totalStreams = providers.reduce((sum, provider) => sum + provider.streams.length, 0);
  return <main className="sources-page">
    <header className="sources-heading"><button className="back-link dark" onClick={() => navigate(`/titulo/${type}/${encodeURIComponent(contentId)}`)}>← Voltar</button><div><span className="eyebrow">ETAPA 2 DE 2</span><h1>Escolha suas fontes</h1><p>{title}</p></div><div className="source-progress"><strong>{job?.completed || 0}/{job?.total || 0}</strong><span>provedores concluídos</span></div></header>
    <div className="source-layout">
      <aside className="provider-sidebar"><div className="sidebar-heading"><h2>Provedores</h2><span>{ready.length} com resultados</span></div><button className="provider-filter all-filter" onClick={() => setVisibleProviders(new Set(providers.map((provider) => provider.addonId)))}><span className="check-symbol">✓</span> Todos <small>{totalStreams}</small></button><div className="provider-filter-list">{providers.map((provider) => <label className="provider-filter" key={provider.addonId}><input type="checkbox" checked={visibleProviders.has(provider.addonId)} onChange={() => setVisibleProviders((current) => { const next = new Set(current); next.has(provider.addonId) ? next.delete(provider.addonId) : next.add(provider.addonId); return next; })} /><StatusDot status={provider.status} /><span>{provider.name}</span><small>{provider.status === 'ready' ? provider.streams.length : statusLabel(provider.status)}</small></label>)}</div>{providers.some((provider) => provider.status === 'error') && <button className="secondary wide" onClick={retryFailed}>Tentar provedores com erro</button>}</aside>
      <section className="source-results"><div className="source-result-header"><div><h2>Resultados disponíveis</h2><p>{job?.status === 'running' ? 'Os resultados aparecem assim que cada provedor responde.' : `${totalStreams} fonte${totalStreams === 1 ? '' : 's'} encontrada${totalStreams === 1 ? '' : 's'}.`}</p></div>{eventError && <span className="inline-warning">{eventError}</span>}</div>{!job && <SourcesSkeleton />}{job && !ready.length && job.status === 'running' && <SourcesSkeleton />}{job && !ready.length && job.status !== 'running' && <EmptyState title="Nenhuma fonte retornou" body="Verifique os addons habilitados em Configurações ou tente outro conteúdo." action="Abrir configurações" onAction={() => navigate('/configuracoes')} />}{providers.filter((provider) => visibleProviders.has(provider.addonId)).map((provider) => <ProviderGroup key={provider.addonId} provider={provider} video={video} audio={audio} setVideo={setVideo} setAudio={setAudio} torrentAvailable={health.torrentSourceAvailable ?? health.torrentGatewayConfigured} />)}</section>
      <aside className="selection-panel"><span className="eyebrow">SUA COMBINAÇÃO</span><h2>Vídeo + áudio</h2><SelectionSummary label="Vídeo" source={video} empty="Escolha uma fonte de vídeo" /><SelectionSummary label="Áudio" source={audio} empty="Escolha uma fonte de áudio" /><div className="selection-fields"><label>Nome da combinação<input value={label} onChange={(event) => setLabel(event.target.value)} /></label></div><button className="secondary wide sync-button" disabled={!hasSelections} onClick={() => setSyncing(true)}>Sincronizar fontes <span>{Number(offset).toFixed(1)} s</span></button>{type === 'series' && <div className="callout info">Este modelo será buscado automaticamente em cada episódio onde os dois provedores retornarem fontes equivalentes.</div>}{preflight?.status === 'success' && <div className="callout success">Compatível sem perdas · duração de {preflight.duration.toFixed(1)} segundos.</div>}{preflight?.status === 'success' && preflight.durationDriftSeconds > 0.1 && <div className="callout warning">As durações diferem {preflight.durationDriftSeconds.toFixed(1)} s. Isso não impede a combinação; ajuste a sincronização se necessário.</div>}{preflight?.status === 'error' && <div className="callout danger">{preflight.message}</div>}<button className="secondary wide" disabled={!hasSelections || preflight?.status === 'loading'} onClick={validate}>{preflight?.status === 'loading' ? 'Validando…' : 'Validar sem perdas'}</button><button className="primary wide" disabled={!hasSelections || saving} onClick={save}>{saving ? 'Salvando…' : type === 'series' ? 'Salvar modelo da série' : 'Salvar combinação'} <span>→</span></button><p className="selection-note">Vídeo e áudio são copiados sem recodificação. Diferenças de duração são informativas, nunca bloqueiam o stream.</p></aside>
    </div>
    {syncing && <SyncModal contentId={contentId} videoId={videoId} type={type} video={video} audio={audio} initialOffset={offset} onSourcesRenewed={(sources) => { setVideo(sources.video); setAudio(sources.audio); }} onApply={(nextOffset) => { setOffset(nextOffset); setPreflight(null); setSyncing(false); }} onClose={() => setSyncing(false)} />}
  </main>;
}

function SyncModal({ contentId, videoId, type, video, audio, initialOffset, onSourcesRenewed, onApply, onClose }) {
  const [offset, setOffset] = useState(Number(initialOffset) || 0);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const previewId = useRef(null);
  const requestVersion = useRef(0);
  const requestedOffset = useRef(null);
  async function releasePreview(id) { if (id) await api(`/api/previews/${id}`, { method: 'DELETE' }).catch(() => {}); }
  async function loadPreview(nextOffset) {
    if (requestedOffset.current === Number(nextOffset)) return;
    requestedOffset.current = Number(nextOffset);
    const version = ++requestVersion.current;
    setLoading(true); setError('');
    try {
      const result = await api('/api/previews', { method: 'POST', body: JSON.stringify({ contentId, videoId, type, video, audio, audioOffsetSeconds: Number(nextOffset) }) });
      if (version !== requestVersion.current) return void releasePreview(result.preview.id);
      if (result.sources) onSourcesRenewed(result.sources);
      const previousId = previewId.current;
      previewId.current = result.preview.id;
      setPreview(result.preview); setLoading(false);
      void releasePreview(previousId);
    } catch (requestError) {
      requestedOffset.current = null;
      if (version === requestVersion.current) { setError(toastText(requestError)); setLoading(false); }
    }
  }
  useEffect(() => {
    void loadPreview(offset);
    return () => { requestVersion.current += 1; void releasePreview(previewId.current); };
  }, []);
  function updateOffset(event) { setOffset(Number(event.target.value)); }
  function commitOffset() { void loadPreview(offset); }
  return <div className="modal-backdrop" role="presentation"><section className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title"><header><div><span className="eyebrow">SINCRONIZAÇÃO</span><h2 id="sync-title">Ajuste o áudio sem perdas</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar sincronizador">×</button></header><p>Use o controle abaixo: valores positivos atrasam o áudio; negativos o adiantam. A prévia usa o mesmo pipeline do addon, sem recodificar as fontes.</p><div className="preview-player">{loading && <div className="preview-loading">Preparando prévia…</div>}{preview && <HlsPreviewPlayer src={preview.url} onError={setError} />}{error && <div className="callout danger">{error}</div>}</div><label className="offset-control"><span>Offset do áudio <strong>{offset.toFixed(1)} s</strong></span><input type="range" min="-120" max="120" step="0.1" value={offset} onChange={updateOffset} onPointerUp={commitOffset} onKeyUp={commitOffset} onBlur={commitOffset} aria-label="Offset do áudio em segundos" /><small>−120 s <span>0 s</span> +120 s</small></label><footer><button className="secondary" onClick={onClose}>Cancelar</button><button className="primary" onClick={() => onApply(offset)}>Aplicar sincronização <span>→</span></button></footer></section></div>;
}

function HlsPreviewPlayer({ src, onError }) {
  const player = useRef(null);
  useEffect(() => {
    const element = player.current;
    if (!element || !src) return undefined;
    let cancelled = false;
    let hls = null;
    if (element.canPlayType('application/vnd.apple.mpegurl') && 'ManagedMediaSource' in window) {
      element.src = src;
    } else {
      // hls.js documents this loadSource/attachMedia lifecycle for MSE browsers.
      // https://github.com/video-dev/hls.js/blob/master/docs/API.md
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) return onError('Este navegador não oferece suporte à prévia HLS.');
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) onError('A prévia não pôde ser reproduzida com estas fontes.'); });
        hls.loadSource(src);
        hls.attachMedia(element);
      }).catch(() => !cancelled && onError('Não foi possível iniciar o player de prévia.'));
    }
    return () => { cancelled = true; hls?.destroy(); element.removeAttribute('src'); element.load(); };
  }, [src, onError]);
  return <video ref={player} controls autoPlay playsInline aria-label="Prévia sincronizada de vídeo e áudio" />;
}

function ProviderGroup({ provider, video, audio, setVideo, setAudio, torrentAvailable }) {
  const [open, setOpen] = useState(true);
  if (provider.status === 'pending' || provider.status === 'loading') return <section className="provider-group loading-provider"><button className="provider-title" onClick={() => setOpen(!open)}><span><StatusDot status="loading" />{provider.name}</span><small>Buscando fontes…</small></button></section>;
  if (provider.status === 'empty') return <section className="provider-group empty-provider"><button className="provider-title" onClick={() => setOpen(!open)}><span><StatusDot status="empty" />{provider.name}</span><small>Sem fontes</small></button></section>;
  if (provider.status === 'error') return <section className="provider-group error-provider"><button className="provider-title" onClick={() => setOpen(!open)}><span><StatusDot status="error" />{provider.name}</span><small>Não respondeu</small></button>{open && <p>{provider.error}</p>}</section>;
  return <section className="provider-group"><button className="provider-title" onClick={() => setOpen(!open)} aria-expanded={open}><span><StatusDot status="ready" />{provider.name}</span><small>{provider.streams.length} fonte{provider.streams.length === 1 ? '' : 's'} <b>{open ? '⌃' : '⌄'}</b></small></button>{open && <VirtualSourceList streams={provider.streams} video={video} audio={audio} setVideo={setVideo} setAudio={setAudio} torrentAvailable={torrentAvailable} />}</section>;
}

function VirtualSourceList({ streams, video, audio, setVideo, setAudio, torrentAvailable }) {
  const [scrollTop, setScrollTop] = useState(0);
  const itemHeight = 94;
  const visibleCount = 5;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - 2);
  const end = Math.min(streams.length, start + visibleCount + 4);
  return <div className="stream-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}><div style={{ height: streams.length * itemHeight, position: 'relative' }}>{streams.slice(start, end).map((stream, index) => { const position = start + index; return <div className="stream-position" style={{ transform: `translateY(${position * itemHeight}px)` }} key={`${stream.url || stream.infoHash}-${position}`}><SourceCard stream={stream} selected={sameSource(video, stream) ? 'video' : sameSource(audio, stream) ? 'audio' : null} onVideo={() => setVideo(stream)} onAudio={() => setAudio(stream)} torrentAvailable={torrentAvailable} /></div>; })}</div></div>;
}

function SourceCard({ stream, selected, onVideo, onAudio, torrentAvailable }) {
  const unavailable = stream.kind === 'torrent' && !torrentAvailable;
  return <article className={classNames('stream-card', selected && `chosen-${selected}`, unavailable && 'unavailable')}><div className="stream-main"><div className="stream-badges"><span>{stream.quality || 'AUTO'}</span><span>{sourceKinds[stream.kind] || 'Fonte'}</span>{selected && <span className="selection-badge">{selected === 'video' ? 'VÍDEO' : 'ÁUDIO'}</span>}</div><strong>{stream.title || stream.name || 'Fonte sem descrição'}</strong><small>{unavailable ? 'Torrent indisponível: configure o Torbox ou um gateway.' : 'Escolha o uso desta fonte'}</small></div><div className="stream-actions"><button disabled={unavailable} className={classNames(videoButtonClass(selected))} onClick={onVideo}>Vídeo</button><button disabled={unavailable} className={classNames(audioButtonClass(selected))} onClick={onAudio}>Áudio</button></div></article>;
}
function videoButtonClass(selected) { return selected === 'video' ? 'selected-source' : ''; }
function audioButtonClass(selected) { return selected === 'audio' ? 'selected-source' : ''; }

function MixesPage({ onToast }) {
  const [mixes, setMixes] = useState(null);
  const [cache, setCache] = useState({ bytes: 0, mixes: [] });
  const [expandedId, setExpandedId] = useState(null);
  const [clearTarget, setClearTarget] = useState(null);
  async function load() {
    try {
      const [mixResult, cacheResult] = await Promise.all([api('/api/mixes'), api('/api/preload-cache')]);
      setMixes(mixResult.mixes); setCache(cacheResult);
    } catch (error) { onToast(toastText(error)); }
  }
  useEffect(() => { void load(); }, []);
  async function remove(id) { try { await api(`/api/mixes/${id}`, { method: 'DELETE' }); await load(); onToast('Combinação removida.'); } catch (error) { onToast(toastText(error)); } }
  const cacheFor = (id) => cache.mixes?.find((item) => item.id === id)?.status?.cache;
  return <main className="page mixes-page"><section className="page-heading split-heading"><div><span className="eyebrow">BIBLIOTECA</span><h1>Combinações salvas</h1><p>Prepare localmente antes de abrir no Nuvio e acompanhe o estado real de cada stream.</p></div><span className="count-badge">{mixes?.length || 0}</span></section><section className="cache-summary"><div><span className="eyebrow">CACHE LOCAL</span><strong>{formatBytes(cache.bytes)}</strong><p>Segmentos VOD prontos permanecem no disco até você limpá-los.</p></div><button className="secondary" disabled={!cache.bytes} onClick={() => setClearTarget({ kind: 'all' })}>Limpar todo cache</button></section>{mixes === null && <ListSkeleton />}{mixes?.length === 0 && <EmptyState title="Nenhuma combinação salva" body="Volte à busca para escolher vídeo e áudio de seus provedores." />}{mixes?.length > 0 && <section className="mix-list">{mixes.map((mix) => <article className={classNames('mix-row', expandedId === mix.id && 'expanded')} key={mix.id}><div className="mix-icon">◌</div><div className="mix-copy"><strong>{mix.label}</strong><p>{mix.video.sourceAddonName || 'Vídeo'} <span>+</span> {mix.audio.sourceAddonName || 'Áudio'}</p><small>{mix.scope === 'series' ? 'Série · episódio de referência' : mix.type === 'series' ? 'Episódio' : 'Filme'} · atualizado {formatDate(mix.updatedAt)}</small>{cacheFor(mix.id) && <span className="cache-mini"><StatusDot status={cacheFor(mix.id).state === 'ready' ? 'ready' : 'loading'} />{cacheFor(mix.id).preparedSegments}/{cacheFor(mix.id).totalSegments} segmentos · {formatBytes(cacheFor(mix.id).bytes)}</span>}</div><div className="mix-actions"><button className="secondary" onClick={() => setExpandedId((current) => current === mix.id ? null : mix.id)}>{expandedId === mix.id ? 'Fechar' : 'Preparar localmente'}</button><button className="danger-ghost" onClick={() => remove(mix.id)}>Remover</button></div>{expandedId === mix.id && <PreloadPanel mix={mix} onToast={onToast} onChanged={load} onClear={() => setClearTarget({ kind: 'mix', mix })} />}</article>)}</section>}{clearTarget && <CacheClearDialog target={clearTarget} onClose={() => setClearTarget(null)} onDone={async (includeKeyframes) => {
    try {
      const path = clearTarget.kind === 'all' ? '/api/preload-cache' : `/api/mixes/${clearTarget.mix.id}/preload/cache`;
      await api(path, { method: 'DELETE', body: JSON.stringify({ includeKeyframes }) });
      await load(); setClearTarget(null); onToast(includeKeyframes ? 'Mídia e índices removidos.' : 'Somente a mídia preparada foi removida.');
    } catch (error) { onToast(toastText(error)); }
  }} />}</main>;
}

function PreloadPanel({ mix, onToast, onChanged, onClear }) {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [mode, setMode] = useState('start');
  const [startSeconds, setStartSeconds] = useState('0');
  const [endSeconds, setEndSeconds] = useState('');
  const [pending, setPending] = useState(false);
  async function refresh() {
    try {
      const result = await api(`/api/mixes/${mix.id}/status`);
      setStatus(result.preload); setSessions(result.sessions);
    } catch (error) { onToast(toastText(error)); }
  }
  useEffect(() => {
    void refresh();
    const events = typeof EventSource === 'function' ? new EventSource(`/api/mixes/${encodeURIComponent(mix.id)}/preload/events`) : null;
    events?.addEventListener('status', (event) => setStatus(JSON.parse(event.data)));
    const timer = setInterval(() => void refresh(), 4000);
    return () => { events?.close(); clearInterval(timer); };
  }, [mix.id]);
  async function begin() {
    setPending(true);
    try {
      const payload = { mode, startSeconds: Number(startSeconds || 0) };
      if (mode === 'range' && endSeconds !== '') payload.endSeconds = Number(endSeconds);
      const result = await api(`/api/mixes/${mix.id}/preload`, { method: 'POST', body: JSON.stringify(payload) });
      setStatus(result.preload); onChanged();
    } catch (error) { onToast(toastText(error)); }
    finally { setPending(false); }
  }
  async function cancel() {
    try { setStatus((await api(`/api/mixes/${mix.id}/preload/cancel`, { method: 'POST' })).preload); }
    catch (error) { onToast(toastText(error)); }
  }
  const running = status?.running;
  const cache = status?.cache;
  const events = status?.events || [];
  const diagnostics = Object.values(sessions || {}).flatMap((session) => session?.diagnostics ? [session.diagnostics] : []);
  const activeSegments = status?.activeSegments || [];
  const activity = activeSegments.length ? `Segmentos ${activeSegments.join(', ')}` : status?.currentSegment ? `Segmento ${status.currentSegment}` : status?.indexingElapsedSeconds !== null && status?.indexingElapsedSeconds !== undefined ? `Indexando há ${formatDuration(status.indexingElapsedSeconds)}` : running ? 'Validando fontes' : 'Em espera';
  return <section className="preload-panel" aria-label={`Preparação local de ${mix.label}`}><header><div><span className="eyebrow">PRÉ-CARREGAMENTO VOD</span><h2>Pronto antes de abrir no Nuvio</h2><p>A duração fixa e o avanço continuam disponíveis. O Nuvio usa o que já estiver local e prepara o restante sob demanda.</p></div><span className={classNames('status-chip', status?.state === 'ready' ? 'success' : running ? 'warning' : '')}>{preloadStateLabel(status?.state)}</span></header><div className="preload-metrics"><Metric label="Duração total" value={formatDuration(cache?.duration)} /><Metric label="Segmentos locais" value={cache ? `${cache.preparedSegments}/${cache.totalSegments}` : '0'} /><Metric label="Em disco" value={formatBytes(cache?.bytes)} /><Metric label="Taxa efetiva" value={formatTransferRate(status?.speedBytesPerSecond)} /><Metric label="Atividade" value={activity} /></div><CacheTimeline cache={cache} currentSegment={status?.currentSegment} /><div className="preload-controls"><div className="preload-mode" role="group" aria-label="Modo de preload">{[['start', 'Início'], ['range', 'Trecho'], ['from', 'Do ponto ao fim'], ['all', 'Tudo']].map(([value, label]) => <button type="button" key={value} className={classNames(mode === value && 'selected')} onClick={() => setMode(value)}>{label}</button>)}</div>{(mode === 'range' || mode === 'from') && <div className="time-fields"><label>Início (segundos)<input type="number" min="0" step="1" value={startSeconds} onChange={(event) => setStartSeconds(event.target.value)} /></label>{mode === 'range' && <label>Fim (segundos)<input type="number" min="0" step="1" value={endSeconds} onChange={(event) => setEndSeconds(event.target.value)} placeholder="Obrigatório" /></label>}</div>}<div className="preload-actions"><button className="primary" disabled={pending || running || (mode === 'range' && endSeconds === '')} onClick={begin}>{pending ? 'Iniciando…' : mode === 'all' ? 'Preparar tudo' : 'Iniciar preload'}</button>{running && <button className="secondary" onClick={cancel}>Cancelar</button>}<button className="secondary" disabled={!cache?.bytes} onClick={onClear}>Limpar cache desta combinação</button></div></div>{status?.error && <div className="callout danger">{status.error}</div>}{status?.warnings?.map((warning) => <div className="callout warning" key={warning}>{warning}</div>)}<section className="preload-log-section"><div><h3>Status e logs</h3><span>{events.length} evento{events.length === 1 ? '' : 's'}</span></div>{!events.length && <p className="muted">Ainda não há atividade registrada para esta combinação.</p>}<ol className="preload-log">{events.slice().reverse().map((event, index) => <li className={event.level} key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString('pt-BR')}</time><span>{event.message}</span></li>)}{diagnostics.map((diagnostic, index) => <li className="warning" key={`diagnostic-${index}`}><time>FFmpeg</time><span>{diagnostic}</span></li>)}</ol></section></section>;
}

function Metric({ label, value }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function CacheTimeline({ cache, currentSegment }) {
  const track = useRef(null);
  const [hoverSeconds, setHoverSeconds] = useState(null);
  const duration = Number(cache?.duration || 0);
  const ranges = cache?.cachedRanges || [];
  const lastCachedSeconds = ranges.at(-1)?.endSeconds || 0;
  const progress = duration > 0 && Number.isInteger(currentSegment) ? Math.min(100, Math.max(0, ((ranges.at(-1)?.endSeconds || 0) / duration) * 100)) : null;
  function updateHover(event) {
    const rect = track.current?.getBoundingClientRect();
    if (!rect?.width || !duration) return;
    setHoverSeconds(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  }
  return <section className="cache-timeline" aria-label="Trechos disponíveis no cache local"><div className="cache-timeline-heading"><span>Disponibilidade local</span><small>{ranges.length ? `${ranges.length} trecho${ranges.length === 1 ? '' : 's'} disponível${ranges.length === 1 ? '' : 'is'}` : 'Nenhum trecho pronto ainda'}</small></div><div className="cache-timeline-summary"><span>Cache até <strong>{formatDuration(lastCachedSeconds)}</strong></span><span>{duration ? `${((lastCachedSeconds / duration) * 100).toFixed(1)}% local` : '—'}</span></div><div ref={track} className="cache-track" role="img" aria-label={ranges.length ? 'Trechos em azul estão disponíveis localmente.' : 'Nenhum trecho disponível localmente.'} onPointerMove={updateHover} onPointerLeave={() => setHoverSeconds(null)}>{ranges.map((range, index) => <i key={`${range.startSeconds}-${index}`} className="cache-range" style={{ left: `${(range.startSeconds / duration) * 100}%`, width: `${Math.max(0.25, ((range.endSeconds - range.startSeconds) / duration) * 100)}%` }} />)}{progress !== null && <b className="cache-cursor" style={{ left: `${progress}%` }} aria-label="Segmento em preparação" />}{hoverSeconds !== null && <output className="cache-hover-time" style={{ left: `${(hoverSeconds / duration) * 100}%` }}>{formatDuration(hoverSeconds)}</output>}</div><div className="cache-timeline-scale"><span>0:00</span><span>{formatDuration(duration)}</span></div></section>;
}
function preloadStateLabel(state) { return ({ idle: 'Sem cache', indexing: 'Indexando', preloading: 'Preparando', ready: 'Pronto', partial: 'Parcial', failed: 'Falhou', cancelled: 'Cancelado' })[state] || 'Sem cache'; }
function CacheClearDialog({ target, onClose, onDone }) { return <div className="modal-backdrop" role="presentation"><section className="cache-dialog" role="dialog" aria-modal="true" aria-labelledby="cache-clear-title"><span className="eyebrow">LIMPEZA DE CACHE</span><h2 id="cache-clear-title">{target.kind === 'all' ? 'Limpar todo o cache local?' : `Limpar cache de “${target.mix.label}”?`}</h2><p>Os segmentos prontos serão removidos. Na próxima abertura ou preload, eles precisarão ser preparados novamente.</p><div className="cache-dialog-actions"><button className="secondary" onClick={onClose}>Cancelar</button><button className="secondary" onClick={() => onDone(false)}>Somente mídia</button><button className="danger-solid" onClick={() => onDone(true)}>Mídia e índices</button></div></section></div>; }

function SettingsPage({ connection, health, navigate, onToast, onHealthChange }) {
  const [addons, setAddons] = useState(null);
  const [manifestUrl, setManifestUrl] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [torboxApiKey, setTorboxApiKey] = useState('');
  const [savingTorbox, setSavingTorbox] = useState(false);
  const manifest = `${window.location.origin}/manifest.json`;
  async function load() { try { setAddons((await api('/api/addons')).addons); } catch (error) { onToast(toastText(error)); } }
  useEffect(() => { void load(); }, []);
  async function toggle(addon) { try { await api(`/api/addons/${addon.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !addon.enabled }) }); await load(); } catch (error) { onToast(toastText(error)); } }
  async function remove(id) { try { await api(`/api/addons/${id}`, { method: 'DELETE' }); await load(); } catch (error) { onToast(toastText(error)); } }
  async function addManifest(event) { event.preventDefault(); try { await api('/api/addons', { method: 'POST', body: JSON.stringify({ manifestUrl }) }); setManifestUrl(''); await load(); onToast('Manifest importado.'); } catch (error) { onToast(toastText(error)); } }
  async function sync() { setSyncing(true); try { const result = await api('/api/nuvio/import-addons', { method: 'POST', body: JSON.stringify({ profileId: connection?.profileId }) }); await load(); onToast(`${result.imported} addon${result.imported === 1 ? '' : 's'} sincronizado${result.imported === 1 ? '' : 's'}.`); } catch (error) { onToast(toastText(error)); } finally { setSyncing(false); } }
  async function saveTorbox(event) {
    event.preventDefault();
    setSavingTorbox(true);
    try {
      await api('/api/debrid/torbox', { method: 'POST', body: JSON.stringify({ apiKey: torboxApiKey }) });
      setTorboxApiKey('');
      onHealthChange(await api('/api/health'));
      onToast('Chave do Torbox salva com segurança.');
    } catch (error) { onToast(toastText(error)); }
    finally { setSavingTorbox(false); }
  }
  return <main className="page settings-page"><section className="page-heading"><span className="eyebrow">CONFIGURAÇÕES</span><h1>Seu ambiente de fontes</h1><p>Gerencie os provedores consultados pelo Mixer e a integração com o Nuvio.</p></section><section className="settings-grid"><article className="settings-card account-card"><div className="settings-card-heading"><span className="setting-icon">◉</span><div><h2>Conta Nuvio</h2><p>{connection?.sessionAvailable ? 'Sessão cifrada no volume Docker.' : 'A sessão precisa ser conectada novamente.'}</p></div><span className={classNames('status-chip', connection?.sessionAvailable ? 'success' : 'warning')}>{connection?.sessionAvailable ? 'Conectada' : 'Atenção'}</span></div><dl><div><dt>Perfil</dt><dd>{connection?.profileId ?? 'Não selecionado'}</dd></div><div><dt>Última conexão</dt><dd>{formatDate(connection?.updatedAt) || '—'}</dd></div></dl><div className="settings-actions"><button className="secondary" onClick={sync} disabled={syncing || !connection?.sessionAvailable}>{syncing ? 'Sincronizando…' : 'Sincronizar addons'}</button><button className="text-action" onClick={() => navigate('/login')}>Trocar conta →</button></div></article><article className="settings-card addon-card"><div className="settings-card-heading"><span className="setting-icon">⌁</span><div><h2>Addon NuvioMixer</h2><p>Instale esta URL no Nuvio para reproduzir as combinações salvas.</p></div></div><code className="manifest-url">{manifest}</code><button className="secondary" onClick={() => navigator.clipboard.writeText(manifest).then(() => onToast('URL copiada.')).catch(() => onToast('Selecione e copie a URL.'))}>Copiar URL</button></article><article className="settings-card"><div className="settings-card-heading"><span className="setting-icon">◇</span><div><h2>Torbox</h2><p>Use sua chave de API para habilitar fontes torrent nativas.</p></div><span className={classNames('status-chip', health.torboxConfigured ? 'success' : 'warning')}>{health.torboxConfigured ? 'Configurada' : 'Não configurada'}</span></div><form className="manifest-form" onSubmit={saveTorbox}><input id="torbox-api-key" aria-label="Chave de API do Torbox" type="password" autoComplete="off" value={torboxApiKey} onChange={(event) => setTorboxApiKey(event.target.value)} placeholder="Cole sua chave de API" required /><button className="secondary" disabled={savingTorbox || !health.credentialsStorageReady}>{savingTorbox ? 'Salvando…' : 'Salvar chave Torbox'}</button></form><p>A chave é cifrada no volume Docker e nunca é exibida novamente.</p></article></section>{!health.credentialsStorageReady && <div className="callout danger"><strong>MASTER_KEY ausente</strong><span>O Mixer não pode guardar ou renovar uma sessão sem essa chave.</span></div>}<section className="addon-section"><div className="section-title"><div><span className="eyebrow">PROVEDORES</span><h2>Addons disponíveis</h2></div><span className="muted">{addons?.filter((addon) => addon.enabled).length || 0} ativos</span></div><form className="manifest-form" onSubmit={addManifest}><input type="url" value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} required placeholder="https://addon.exemplo/manifest.json" /><button className="secondary">Importar manifest</button></form>{addons === null && <ListSkeleton />}{addons?.length === 0 && <EmptyState title="Nenhum addon disponível" body="Conecte a conta Nuvio e sincronize, ou importe um manifest manualmente." />}{addons?.length > 0 && <div className="addon-list">{addons.map((addon) => <article className="addon-row" key={addon.id}><button className={classNames('toggle', addon.enabled && 'on')} role="switch" aria-checked={addon.enabled} aria-label={`Ativar ${addon.name}`} onClick={() => toggle(addon)}><span /></button><div><strong>{addon.name}</strong><small>{addon.manifestUrl}</small></div><button className="danger-ghost" onClick={() => remove(addon.id)}>Remover</button></article>)}</div>}</section></main>;
}

function Poster({ src, title, compact = false }) { return <div className={classNames('poster', compact && 'compact')}>{src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden="true">◌</span>}</div>; }
function StatusDot({ status }) { return <span className={classNames('status-dot', status)} aria-label={statusLabel(status)} />; }
function statusLabel(status) { return ({ pending: 'Aguardando', loading: 'Carregando', ready: 'Pronto', empty: 'Sem fontes', error: 'Erro' })[status] || status; }
function SelectionSummary({ label, source, empty }) { return <div className={classNames('selection-summary', source && 'filled')}><span>{label}</span>{source ? <><strong>{source.sourceAddonName || source.name}</strong><small>{source.quality || 'Qualidade não informada'} · {sourceKinds[source.kind]}</small></> : <p>{empty}</p>}</div>; }
function EmptyState({ title, body, action, onAction }) { return <section className="empty-state"><span aria-hidden="true">◌</span><h2>{title}</h2><p>{body}</p>{action && <button className="secondary" onClick={onAction}>{action}</button>}</section>; }
function ResultSkeletons() { return <section className="media-grid">{Array.from({ length: 8 }, (_, index) => <div className="skeleton media-skeleton" key={index} />)}</section>; }
function DetailSkeleton() { return <><div className="skeleton hero-skeleton" /><div className="skeleton lines-skeleton" /></>; }
function SourcesSkeleton() { return <div className="source-skeletons">{Array.from({ length: 3 }, (_, index) => <div className="skeleton source-skeleton" key={index} />)}</div>; }
function ListSkeleton() { return <div className="list-skeleton">{Array.from({ length: 3 }, (_, index) => <div className="skeleton source-skeleton" key={index} />)}</div>; }

export function App() {
  const [route, navigate] = useRoute();
  const [health, setHealth] = useState(null);
  const [connection, setConnection] = useState(null);
  const [toast, setToast] = useState('');
  const initialized = useRef(false);
  useEffect(() => {
    Promise.all([api('/api/health'), api('/api/nuvio/connection')]).then(([nextHealth, nextConnection]) => {
      setHealth(nextHealth); setConnection(nextConnection);
      if (!initialized.current && route.pathname === '/' && nextConnection.previouslyConnected) navigate('/buscar', true);
      else if (!initialized.current && route.pathname === '/') navigate('/login', true);
      initialized.current = true;
    }).catch((error) => { setToast(toastText(error)); setHealth({ credentialsStorageReady: false, torrentGatewayConfigured: false }); setConnection({ previouslyConnected: false, sessionAvailable: false }); });
  }, []);
  useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  if (!health || !connection) return <LoadingScreen />;
  if (route.pathname === '/login' || (!connection.previouslyConnected && route.pathname === '/')) return <><LoginPage health={health} onToast={setToast} onConnected={(nextConnection) => { setConnection(nextConnection); navigate('/buscar', true); }} />{toast && <div className="toast" role="status">{toast}</div>}</>;
  let content;
  if (route.pathname.startsWith('/titulo/')) content = <DetailPage route={route} navigate={navigate} onToast={setToast} />;
  else if (route.pathname.startsWith('/fontes/')) content = <SourcePage route={route} navigate={navigate} health={health} onToast={setToast} />;
  else if (route.pathname.startsWith('/combinacoes')) content = <MixesPage onToast={setToast} />;
  else if (route.pathname.startsWith('/configuracoes')) content = <SettingsPage connection={connection} health={health} navigate={navigate} onToast={setToast} onHealthChange={setHealth} />;
  else content = <SearchPage navigate={navigate} />;
  return <><AppShell route={route} navigate={navigate} connection={connection} health={health} onToast={setToast}>{content}</AppShell>{toast && <div className="toast" role="status">{toast}</div>}</>;
}
