import { fetchJson } from './stremio.js';

const cinemetaBase = 'https://v3-cinemeta.strem.io';

function catalogUrl(path) {
  return `${cinemetaBase}${path}`;
}

function normalizeMeta(meta) {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name || 'Sem título',
    year: meta.year || '',
    poster: meta.poster || null,
    background: meta.background || null,
    description: meta.description || '',
    genres: Array.isArray(meta.genre) ? meta.genre : [],
    runtime: meta.runtime || null,
  };
}

export async function searchCatalog(query, type) {
  const catalog = await fetchJson(catalogUrl(`/catalog/${type}/top/search=${encodeURIComponent(query)}.json`), { timeoutMs: 12000 });
  return (catalog.metas || []).slice(0, 30).map(normalizeMeta);
}

function normalizeEpisode(video, seriesId) {
  const season = Number(video.season);
  const episode = Number(video.episode);
  return {
    id: video.id || `${seriesId}:${season}:${episode}`,
    season,
    episode,
    name: video.title || `Episódio ${episode}`,
    description: video.overview || video.description || '',
    thumbnail: video.thumbnail || null,
    released: video.released || null,
  };
}

export async function getCatalogDetail(type, id) {
  const document = await fetchJson(catalogUrl(`/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`), { timeoutMs: 12000 });
  const meta = document.meta;
  if (!meta?.id) throw new Error('O catálogo não retornou detalhes válidos para este título.');
  const detail = normalizeMeta(meta);
  if (type !== 'series') return { ...detail, videoId: meta.id };

  const grouped = new Map();
  for (const video of meta.videos || []) {
    const episode = normalizeEpisode(video, meta.id);
    if (!Number.isInteger(episode.season) || !Number.isInteger(episode.episode) || episode.season < 0 || episode.episode < 1) continue;
    const episodes = grouped.get(episode.season) || [];
    episodes.push(episode);
    grouped.set(episode.season, episodes);
  }
  const seasons = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([number, episodes]) => ({ number, episodes: episodes.sort((left, right) => left.episode - right.episode) }));
  return { ...detail, seasons };
}
