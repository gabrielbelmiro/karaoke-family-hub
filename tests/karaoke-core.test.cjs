const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/karaoke-core.js');

test('parseLyrics builds timed lines and words', () => {
  const lines = core.parseLyrics('[00:00.00]Casa de cantoria\n[00:03.00]Voz na janela');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Casa de cantoria');
  assert.equal(lines[0].words.length, 3);
  assert.ok(lines[0].words[0].end > lines[0].words[0].start);
});

test('decorateLine flags active words by time', () => {
  const lines = core.parseLyrics('[00:00.00]Hoje a sala vira palco');
  const decorated = core.decorateLine(lines[0], 1.2);
  assert.equal(decorated.words.some((word) => word.active), true);
});

test('evaluateVoiceHit rewards matched word within timing window', () => {
  const lines = core.parseLyrics('[00:00.00]Casa de cantoria');
  const activeWord = core.getActiveWord(lines[0], 0.1);
  const result = core.evaluateVoiceHit({
    transcript: 'Casa',
    activeWord,
    currentTime: 0.12,
    toleranceMs: 500,
  });

  assert.equal(result.status, 'match');
  assert.equal(result.delta, 3);
});

test('evaluateVoiceHit penalizes out-of-rhythm matches', () => {
  const lines = core.parseLyrics('[00:00.00]Casa de cantoria');
  const activeWord = core.getActiveWord(lines[0], 0.1);
  const result = core.evaluateVoiceHit({
    transcript: 'Casa',
    activeWord,
    currentTime: 1.6,
    toleranceMs: 250,
  });

  assert.equal(result.status, 'late');
  assert.equal(result.delta, -5);
  assert.match(result.message, /Fora de Ritmo/);
});

test('hasActiveMicrophone blocks any non-paused microphone', () => {
  assert.equal(core.hasActiveMicrophone(['Microfone pausado']), false);
  assert.equal(core.hasActiveMicrophone(['Microfone pausado', 'Escutando']), true);
  assert.equal(core.hasActiveMicrophone([{ status: 'Escutando', statusCode: 'active' }]), true);
  assert.equal(core.hasActiveMicrophone([{ status: 'Microfone pausado', statusCode: 'paused' }]), false);
});

test('evaluatePerformanceScore applies timing, pitch and db penalties', () => {
  const result = core.evaluatePerformanceScore({
    timingDeltaMs: 240,
    pitchDeltaCents: 48,
    dbDelta: 6,
  });

  assert.equal(result.score < 100, true);
  assert.equal(result.penalties.length, 3);
  assert.equal(result.penalties[0].detail, 'Fora de Ritmo');
  assert.equal(result.settings.timingPenalty, -5);
});

test('settings expose playback gate labels', () => {
  assert.equal(core.settings.playback.readyStatus, 'Pronto para tocar');
  assert.equal(core.settings.playback.blockedStatus, 'Aguardando microfone pausado');
});

test('normalizeSong preserves pitch guide metadata', () => {
  const song = core.normalizeSong({
    id: 'demo-track',
    title: 'Demo Track',
    lyrics: '[00:00.00]Tom e ritmo',
    pitchGuideHz: 233.08,
    pitchGuideLabel: 'Bb3',
  });

  assert.equal(song.pitchGuideHz, 233.08);
  assert.equal(song.pitchGuideLabel, 'Bb3');
});

test('normalizeSong derives pitch guide label from frequency', () => {
  const song = core.normalizeSong({
    id: 'demo-track-2',
    title: 'Demo Track 2',
    lyrics: '[00:00.00]Tom e ritmo',
    pitchGuideHz: 220,
  });

  assert.equal(song.pitchGuideLabel, 'A3');
});

test('index loads settings before core and app', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('<script type="module" src="./main.js"></script>'));
  assert.equal(html.includes('./lib/karaoke-settings.js'), false);
  assert.equal(html.includes('./lib/karaoke-core.js'), false);
  assert.equal(html.includes('./app.js'), false);
});

test('scoreSession gives duet a higher score than solo at the same progress', () => {
  const solo = core.scoreSession({ progress: 0.7, offsetMs: 120, profileCount: 1 });
  const duet = core.scoreSession({ progress: 0.7, offsetMs: 120, profileCount: 2 });
  assert.ok(duet.score > solo.score);
  assert.equal(duet.mode, 'Dueto');
});

test('rankProfiles sorts by best score and total score', () => {
  const ranking = core.rankProfiles([
    { nickname: 'A', bestScore: 85, totalScore: 120 },
    { nickname: 'B', bestScore: 92, totalScore: 100 },
    { nickname: 'C', bestScore: 85, totalScore: 140 },
  ]);

  assert.equal(ranking[0].nickname, 'B');
  assert.equal(ranking[1].nickname, 'C');
});
