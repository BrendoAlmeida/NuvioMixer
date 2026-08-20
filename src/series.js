function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function qualityHint(source) {
  const declared = normalizeText(source?.quality);
  if (declared) return declared;
  const match = /\b(2160p|4k|1080p|720p|576p|480p|360p)\b/i.exec(`${source?.title || ''} ${source?.name || ''}`);
  return match ? match[1].toLowerCase() : null;
}

export function sourceSelector(source) {
  return {
    addonId: String(source.sourceAddonId || ''),
    kind: source.kind,
    quality: qualityHint(source)
  };
}

export function selectEquivalentStream(streams, selector) {
  if (!selector?.addonId || !selector.kind) return null;
  const compatible = streams.filter((stream) => stream.sourceAddonId === selector.addonId && stream.kind === selector.kind);
  if (!selector.quality) return compatible[0] || null;
  return compatible.find((stream) => qualityHint(stream) === selector.quality) || null;
}

/** Reconsulta somente os addons originalmente escolhidos para renovar links temporários. */
export async function resolveSavedMixSources({ mix, addons, getStreams }) {
  const videoSelector = mix.videoSelector || sourceSelector(mix.video);
  const audioSelector = mix.audioSelector || sourceSelector(mix.audio);
  const selectors = [videoSelector, audioSelector];
  const requiredIds = [...new Set(selectors.map((selector) => selector?.addonId).filter(Boolean))];
  if (!requiredIds.length) return null;
  const available = new Map(addons.filter((addon) => addon.enabled).map((addon) => [addon.id, addon]));
  if (requiredIds.some((id) => !available.has(id))) return null;
  const resolved = await Promise.all(requiredIds.map(async (id) => [id, await getStreams(available.get(id), mix.type, mix.videoId || mix.contentId)]));
  const byAddon = new Map(resolved);
  const video = selectEquivalentStream(byAddon.get(videoSelector.addonId) || [], videoSelector);
  const audio = selectEquivalentStream(byAddon.get(audioSelector.addonId) || [], audioSelector);
  return video && audio ? { video, audio } : null;
}

export function isEpisodeOfSeries(videoId, seriesId) {
  return String(videoId).startsWith(`${String(seriesId)}:`);
}

export async function resolveSeriesEpisode({ template, videoId, addons, getStreams }) {
  if (template.scope !== 'series' || !template.videoSelector || !template.audioSelector || !isEpisodeOfSeries(videoId, template.contentId)) return null;
  const selectors = [template.videoSelector, template.audioSelector];
  const requiredIds = [...new Set(selectors.map((selector) => selector?.addonId).filter(Boolean))];
  const available = new Map(addons.filter((addon) => addon.enabled).map((addon) => [addon.id, addon]));
  if (requiredIds.some((id) => !available.has(id))) return null;
  const resolved = await Promise.all(requiredIds.map(async (id) => [id, await getStreams(available.get(id), 'series', videoId)]));
  const byAddon = new Map(resolved);
  const video = selectEquivalentStream(byAddon.get(template.videoSelector.addonId) || [], template.videoSelector);
  const audio = selectEquivalentStream(byAddon.get(template.audioSelector.addonId) || [], template.audioSelector);
  return video && audio ? { video, audio } : null;
}
