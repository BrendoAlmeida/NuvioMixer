import test from 'node:test';
import assert from 'node:assert/strict';
import { isEpisodeOfSeries, resolveSavedMixSources, resolveSeriesEpisode, selectEquivalentStream, sourceSelector } from './series.js';

const video1080 = { kind: 'url', sourceAddonId: 'video-provider', quality: '1080p', title: 'S01E01 1080p' };
const audio1080 = { kind: 'url', sourceAddonId: 'audio-provider', quality: '1080p', title: 'S01E01 1080p' };

test('seleciona uma fonte equivalente pelo provedor, tipo e qualidade', () => {
  const selector = sourceSelector(video1080);
  assert.equal(selectEquivalentStream([{ ...video1080, quality: '720p' }, { ...video1080, quality: '1080p' }], selector)?.quality, '1080p');
  assert.equal(selectEquivalentStream([{ ...video1080, sourceAddonId: 'outro' }], selector), null);
});

test('resolve apenas episódios da série e exige os dois provedores equivalentes', async () => {
  const calls = [];
  const template = {
    scope: 'series', contentId: 'tt100',
    videoSelector: sourceSelector(video1080), audioSelector: sourceSelector(audio1080)
  };
  const addons = [{ id: 'video-provider', enabled: true }, { id: 'audio-provider', enabled: true }];
  const getStreams = async (addon, _type, videoId) => {
    calls.push([addon.id, videoId]);
    return addon.id === 'video-provider' ? [{ ...video1080, title: 'S02E03 1080p' }] : [{ ...audio1080, title: 'S02E03 1080p' }];
  };
  const resolved = await resolveSeriesEpisode({ template, videoId: 'tt100:2:3', addons, getStreams });
  assert.equal(resolved?.video.sourceAddonId, 'video-provider');
  assert.equal(resolved?.audio.sourceAddonId, 'audio-provider');
  assert.equal(calls.length, 2);
  assert.equal(await resolveSeriesEpisode({ template, videoId: 'tt200:2:3', addons, getStreams }), null);
  assert.equal(isEpisodeOfSeries('tt100:2:3', 'tt100'), true);
});

test('renova links temporários de uma combinação salva pelos mesmos addons e qualidade', async () => {
  const mix = {
    type: 'movie', contentId: 'tt100', videoId: 'tt100',
    video: video1080, audio: audio1080,
    videoSelector: sourceSelector(video1080), audioSelector: sourceSelector(audio1080)
  };
  const addons = [{ id: 'video-provider', enabled: true }, { id: 'audio-provider', enabled: true }];
  const refreshed = await resolveSavedMixSources({
    mix, addons,
    getStreams: async (addon) => addon.id === 'video-provider'
      ? [{ ...video1080, url: 'https://video.example.test/novo-link' }]
      : [{ ...audio1080, url: 'https://audio.example.test/novo-link' }]
  });
  assert.equal(refreshed?.video.url, 'https://video.example.test/novo-link');
  assert.equal(refreshed?.audio.url, 'https://audio.example.test/novo-link');
});
