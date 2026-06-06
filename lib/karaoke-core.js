/* eslint-disable no-var, no-undef */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KaraokeCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var runtimeRoot = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : {};
  var settings = runtimeRoot.KaraokeSettings || {
    playback: {
      blockedStatus: 'Aguardando microfone pausado',
      readyStatus: 'Pronto para tocar',
      syncingStatus: 'Sincronizando voz',
      pausedStatus: 'Microfone pausado',
    },
    scoring: {
      timingToleranceMs: 180,
      timingPenalty: -5,
      pitchToleranceCents: 35,
      pitchPenaltyAbove: -3,
      pitchPenaltyBelow: -3,
      dbTolerance: 4,
      dbPenalty: -2,
      perfectBonus: 3,
      latePenaltyBoost: -2,
    },
    voice: {
      minConfidence: 0.72,
      transcriptMatchWeight: 1,
      browserHint: 'Chrome ou Edge',
    },
  };
  settings = Object.freeze({
    playback: Object.freeze(settings.playback),
    scoring: Object.freeze(settings.scoring),
    voice: Object.freeze(settings.voice),
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function normalizeToken(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function formatTime(seconds) {
    var safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    var whole = Math.floor(safeSeconds);
    var minutes = Math.floor(whole / 60);
    var remainder = whole % 60;
    return pad(minutes) + ':' + pad(remainder);
  }

  function parseTimestamp(raw) {
    var match = raw.match(/^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/);
    if (!match) {
      return null;
    }

    var minutes = Number(match[1]);
    var seconds = Number(match[2]);
    var fractional = match[3] ? Number(match[3].padEnd(3, '0')) : 0;
    return minutes * 60 + seconds + fractional / 1000;
  }

  function tokenizeLine(text) {
    return text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(function (word) {
        return {
          text: word,
          active: false,
          before: false,
          start: 0,
          end: 0,
        };
      });
  }

  function parseLyrics(rawLyrics) {
    var rows = String(rawLyrics || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(Boolean);
    var lines = [];

    rows.forEach(function (row) {
      var time = parseTimestamp(row);
      if (time === null) {
        return;
      }

      var text = row.replace(/^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/, '').trim();
      if (!text) {
        return;
      }

      lines.push({
        start: time,
        end: time,
        text: text,
        words: tokenizeLine(text),
      });
    });

    for (var index = 0; index < lines.length; index += 1) {
      var current = lines[index];
      var next = lines[index + 1];
      current.end = next ? next.start : current.start + Math.max(3, current.words.length * 0.9);
      var duration = Math.max(0.5, current.end - current.start);
      var step = duration / Math.max(1, current.words.length);
      current.words = current.words.map(function (word, wordIndex) {
        var start = current.start + wordIndex * step;
        var end = wordIndex === current.words.length - 1 ? current.end : start + step;
        return {
          text: word.text,
          active: false,
          before: false,
          start: start,
          end: end,
        };
      });
    }

    return lines;
  }

  function getActiveLine(lines, time) {
    if (!lines.length) {
      return null;
    }

    var active = lines[0];
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      if (time >= line.start && time < line.end) {
        active = line;
        break;
      }
      if (time >= line.end) {
        active = line;
      }
    }

    return active;
  }

  function decorateLine(line, time) {
    if (!line) {
      return null;
    }

    return {
      start: line.start,
      end: line.end,
      text: line.text,
      words: line.words.map(function (word) {
        var active = time >= word.start && time < word.end;
        return {
          text: word.text,
          start: word.start,
          end: word.end,
          active: active,
          before: time >= word.start,
        };
      }),
    };
  }

  function getNeighborLines(lines, time) {
    var activeIndex = -1;
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      if (time >= line.start && time < line.end) {
        activeIndex = index;
        break;
      }
      if (time >= line.end) {
        activeIndex = index;
      }
    }

    return {
      previous: activeIndex > 0 ? lines[activeIndex - 1] : null,
      current: activeIndex >= 0 ? lines[activeIndex] : null,
      next: activeIndex >= 0 && activeIndex + 1 < lines.length ? lines[activeIndex + 1] : null,
    };
  }

  function getActiveWord(line, time) {
    if (!line || !line.words || !line.words.length) {
      return null;
    }

    var active = null;
    for (var index = 0; index < line.words.length; index += 1) {
      var word = line.words[index];
      if (time >= word.start && time < word.end) {
        active = word;
        break;
      }
      if (time >= word.end) {
        active = word;
      }
    }

    return active;
  }

  function countWords(lines) {
    return lines.reduce(function (total, line) {
      return total + line.words.length;
    }, 0);
  }

  function estimateDuration(lines) {
    if (!lines.length) {
      return 180;
    }

    return Math.max(lines[lines.length - 1].end + 2, 30);
  }

  function formatPitchGuideLabel(pitchGuideHz) {
    var hz = Number(pitchGuideHz);
    var noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var midi;
    var noteIndex;
    var octave;

    if (!Number.isFinite(hz) || hz <= 0) {
      return '';
    }

    midi = Math.round(69 + 12 * Math.log2(hz / 440));
    noteIndex = ((midi % 12) + 12) % 12;
    octave = Math.floor(midi / 12) - 1;
    return noteNames[noteIndex] + octave;
  }

  function hashText(text) {
    var input = String(text || '');
    var hash = 0;

    for (var index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) | 0;
    }

    return Math.abs(hash);
  }

  function deriveCoverLabel(rawSong) {
    var title = String(rawSong && rawSong.title ? rawSong.title : '').trim();
    var artist = String(rawSong && rawSong.artist ? rawSong.artist : '').trim();
    var words = (title || artist).split(/\s+/).filter(Boolean);
    var label = words
      .slice(0, 2)
      .map(function (word) {
        return word.charAt(0);
      })
      .join('')
      .toUpperCase();

    if (!label) {
      label = (title.charAt(0) || artist.charAt(0) || '♪').toUpperCase();
    }

    return label.slice(0, 3);
  }

  function deriveCoverTheme(rawSong) {
    var palette = [
      ['#d96bff', '#3a1261'],
      ['#b24dff', '#2a0b46'],
      ['#8b4dff', '#24063f'],
      ['#7d35ff', '#19032c'],
      ['#c06dff', '#43145f'],
      ['#e07bff', '#58156f'],
      ['#a83dff', '#2c0748'],
    ];
    var seed = hashText([rawSong && rawSong.title, rawSong && rawSong.artist, rawSong && rawSong.genre].join('|'));
    var colors = palette[seed % palette.length];
    var label = String(rawSong && rawSong.coverLabel ? rawSong.coverLabel : deriveCoverLabel(rawSong)).trim().toUpperCase();

    return {
      coverLabel: label,
      coverColor: rawSong && rawSong.coverColor ? String(rawSong.coverColor) : colors[0],
      coverAccent: rawSong && rawSong.coverAccent ? String(rawSong.coverAccent) : colors[1],
    };
  }

  function frequencyToMidi(hz) {
    var sourceHz = Number(hz);

    if (!Number.isFinite(sourceHz) || sourceHz <= 0) {
      return null;
    }

    return 69 + 12 * (Math.log(sourceHz / 440) / Math.log(2));
  }

  function analyzePitchMatch(detectedHz, targetHz, toleranceCents) {
    var deltaCents;
    var detectedNote = formatPitchGuideLabel(detectedHz);
    var targetNote = formatPitchGuideLabel(targetHz);
    var detectedMidi = frequencyToMidi(detectedHz);
    var targetMidi = frequencyToMidi(targetHz);

    if (Number.isFinite(detectedHz) && Number.isFinite(targetHz) && detectedHz > 0 && targetHz > 0) {
      deltaCents = Math.round((1200 * Math.log(detectedHz / targetHz)) / Math.log(2));
    } else {
      deltaCents = null;
    }

    if (!Number.isFinite(deltaCents)) {
      return {
        detectedHz: Number(detectedHz) || null,
        targetHz: Number(targetHz) || null,
        detectedMidi: detectedMidi,
        targetMidi: targetMidi,
        deltaCents: null,
        detectedNote: detectedNote,
        targetNote: targetNote,
        direction: 'unavailable',
        withinTolerance: false,
        pitchGrade: 'Sem leitura',
      };
    }

    return {
      detectedHz: Number(detectedHz) || null,
      targetHz: Number(targetHz) || null,
      detectedMidi: detectedMidi,
      targetMidi: targetMidi,
      deltaCents: deltaCents,
      detectedNote: detectedNote,
      targetNote: targetNote,
      direction: Math.abs(deltaCents) <= toleranceCents ? 'aligned' : deltaCents > 0 ? 'above' : 'below',
      withinTolerance: Math.abs(deltaCents) <= toleranceCents,
      pitchGrade: Math.abs(deltaCents) <= toleranceCents ? 'Tom alinhado' : deltaCents > 0 ? 'Tom acima do alvo' : 'Tom abaixo do alvo',
    };
  }

  function normalizeSong(rawSong) {
    var lyricsText = rawSong.lyricsText || rawSong.lyrics || '';
    var lyrics = Array.isArray(rawSong.lyrics) ? rawSong.lyrics : parseLyrics(lyricsText);
    var duration = Number(rawSong.duration) || estimateDuration(lyrics);
    var pitchGuideHz = Number(rawSong.pitchGuideHz);
    var coverTheme = deriveCoverTheme(rawSong);

    return {
      id: rawSong.id,
      title: rawSong.title || 'Sem titulo',
      artist: rawSong.artist || 'Artista local',
      genre: rawSong.genre || 'Familiar',
      mode: rawSong.mode === 'duet' ? 'duet' : 'solo',
      modeLabel: rawSong.mode === 'duet' ? 'Dueto' : 'Solo',
      audioUrl: rawSong.audioUrl || rawSong.audio || '',
      lyricsText: lyricsText,
      lyrics: lyrics,
      duration: duration,
      durationLabel: formatTime(duration),
      wordsCount: countWords(lyrics),
      coverUrl: rawSong.coverDataUrl || rawSong.coverUrl || '',
      coverSource: rawSong.coverSource || rawSong.coverPath || rawSong.coverImagePath || '',
      coverLabel: coverTheme.coverLabel,
      coverColor: coverTheme.coverColor,
      coverAccent: coverTheme.coverAccent,
      pitchGuideHz: Number.isFinite(pitchGuideHz) && pitchGuideHz > 0 ? pitchGuideHz : null,
      pitchGuideLabel: rawSong.pitchGuideLabel || formatPitchGuideLabel(pitchGuideHz),
    };
  }

  function normalizeLibrary(rawLibrary) {
    return (rawLibrary || []).map(normalizeSong);
  }

  function scoreSession(input) {
    var progress = clamp(Number(input.progress) || 0, 0, 1);
    var offsetMs = Math.abs(Number(input.offsetMs) || 0);
    var profileCount = Math.max(1, Number(input.profileCount) || 1);
    var duet = profileCount >= 2;
    var mode = duet ? 'Dueto' : 'Solo';
    var syncFactor = 1 - clamp(offsetMs / 700, 0, 1);
    var harmony = duet ? 18 + Math.min(10, profileCount * 2) : 8;
    var flow = Math.round(progress * 42);
    var timing = Math.round(syncFactor * 32);
    var presence = Math.round(Math.min(18, profileCount * 4));
    var score = clamp(flow + timing + harmony + presence, 0, 100);

    return {
      score: score,
      mode: mode,
      timingGrade: syncFactor > 0.88 ? 'Perfeito' : syncFactor > 0.68 ? 'Excelente' : syncFactor > 0.48 ? 'Bom' : 'Precisa ajuste',
      hint: duet
        ? 'Bonus de harmonia ativo para duas ou mais vozes.'
        : 'Modo solo valorizando sintonia individual.',
    };
  }

  function evaluateVoiceHit(input) {
    var transcript = normalizeToken(input && input.transcript);
    var activeWord = input && input.activeWord ? input.activeWord : null;
    var currentTime = Number(input && input.currentTime) || 0;
    var toleranceMs = Number(input && input.toleranceMs) || settings.scoring.timingToleranceMs;

    if (!transcript || !activeWord) {
      return {
        status: 'idle',
        delta: 0,
        message: '',
        spokenWordText: '',
        activeWordText: activeWord ? activeWord.text : '',
        offsetMs: 0,
      };
    }

    var spokenWordText = transcript.split(/\s+/)[0] || '';
    var activeWordText = normalizeToken(activeWord.text);
    var offsetMs = Math.round((currentTime - activeWord.start) * 1000);
    var withinWindow = Math.abs(offsetMs) <= toleranceMs || (currentTime >= activeWord.start && currentTime <= activeWord.end);
    var matched = spokenWordText === activeWordText;

    if (matched && withinWindow) {
      return {
        status: 'match',
        delta: settings.scoring.perfectBonus,
        message: 'Perfeito: "' + activeWord.text + '" no tempo certo.',
        spokenWordText: spokenWordText,
        activeWordText: activeWord.text,
        offsetMs: offsetMs,
      };
    }

    return {
      status: matched ? 'late' : 'mismatch',
      delta: settings.scoring.timingPenalty,
      message: 'Fora de Ritmo: "' + (spokenWordText || transcript) + '" fora da janela de "' + activeWord.text + '".',
      spokenWordText: spokenWordText,
      activeWordText: activeWord.text,
      offsetMs: offsetMs,
    };
  }

  function evaluatePerformanceScore(input) {
    var timingDeltaMs = Number(input && input.timingDeltaMs);
    var pitchDeltaCents = Number(input && input.pitchDeltaCents);
    var pitchDetectedHz = Number(input && input.pitchDetectedHz);
    var pitchTargetHz = Number(input && input.pitchTargetHz);
    var dbDelta = Number(input && input.dbDelta);
    var mode = input && input.mode === 'Dueto' ? 'Dueto' : 'Solo';
    var profileCount = Math.max(1, Number(input && input.profileCount) || 1);
    var perfectStreak = Math.max(0, Number(input && input.perfectStreak) || 0);
    var errorStreak = Math.max(0, Number(input && input.errorStreak) || 0);
    var score = 100;
    var penalties = [];
    var bonuses = [];
    var consistencyBonus = 0;
    var weights = {
      timing: mode === 'Dueto' || profileCount >= 2 ? 1.1 : 1,
      pitch: mode === 'Dueto' || profileCount >= 2 ? 1.15 : 1,
      db: mode === 'Dueto' || profileCount >= 2 ? 0.85 : 1,
    };
    var timingTolerance = settings.scoring.timingToleranceMs;
    var pitchTolerance = settings.scoring.pitchToleranceCents;
    var dbTolerance = settings.scoring.dbTolerance;
    var pitchAnalysis = null;

    if (!Number.isFinite(pitchDeltaCents) && Number.isFinite(pitchDetectedHz) && Number.isFinite(pitchTargetHz)) {
      pitchAnalysis = analyzePitchMatch(pitchDetectedHz, pitchTargetHz, pitchTolerance);
      pitchDeltaCents = pitchAnalysis.deltaCents;
    } else if (Number.isFinite(pitchDeltaCents)) {
      pitchAnalysis = analyzePitchMatch(
        Number.isFinite(pitchDetectedHz) && pitchDetectedHz > 0
          ? pitchDetectedHz
          : Number.isFinite(pitchTargetHz) && pitchTargetHz > 0
            ? pitchTargetHz * Math.pow(2, pitchDeltaCents / 1200)
            : 440,
        Number.isFinite(pitchTargetHz) && pitchTargetHz > 0 ? pitchTargetHz : 440,
        pitchTolerance,
      );
      pitchAnalysis.deltaCents = pitchDeltaCents;
    }

    if (Number.isFinite(timingDeltaMs) && Math.abs(timingDeltaMs) > timingTolerance) {
      score += Math.round(settings.scoring.timingPenalty * weights.timing);
      penalties.push({
        type: 'timing',
        delta: Math.round(settings.scoring.timingPenalty * weights.timing),
        detail: 'Fora de Ritmo',
      });
      if (Math.abs(timingDeltaMs) > timingTolerance * 2) {
        score += settings.scoring.latePenaltyBoost;
      }
    }

    if (Number.isFinite(pitchDeltaCents) && Math.abs(pitchDeltaCents) > pitchTolerance) {
      score += Math.round((pitchDeltaCents > 0 ? settings.scoring.pitchPenaltyAbove : settings.scoring.pitchPenaltyBelow) * weights.pitch);
      penalties.push({
        type: pitchDeltaCents > 0 ? 'pitch_above' : 'pitch_below',
        delta: Math.round((pitchDeltaCents > 0 ? settings.scoring.pitchPenaltyAbove : settings.scoring.pitchPenaltyBelow) * weights.pitch),
        detail: pitchDeltaCents > 0 ? 'Pitch acima' : 'Pitch abaixo',
        note: pitchAnalysis && pitchAnalysis.detectedNote ? pitchAnalysis.detectedNote : '',
        targetNote: pitchAnalysis && pitchAnalysis.targetNote ? pitchAnalysis.targetNote : '',
        cents: pitchDeltaCents,
      });
    } else if (pitchAnalysis && pitchAnalysis.withinTolerance) {
      bonuses.push({
        type: 'pitch_alignment',
        delta: 1,
        detail: 'Tom alinhado',
        note: pitchAnalysis.detectedNote || '',
        targetNote: pitchAnalysis.targetNote || '',
        cents: pitchAnalysis.deltaCents,
      });
      score += 1;
    }

    if (Number.isFinite(dbDelta) && Math.abs(dbDelta) > dbTolerance) {
      score += Math.round(settings.scoring.dbPenalty * weights.db);
      penalties.push({
        type: 'db',
        delta: Math.round(settings.scoring.dbPenalty * weights.db),
        detail: 'Energia vocal fora do alvo',
      });
    }

    if (!penalties.length) {
      score += settings.scoring.perfectBonus;
      bonuses.push({
        type: 'perfect',
        delta: settings.scoring.perfectBonus,
        detail: 'Execução limpa',
      });

      if (perfectStreak > 1) {
        consistencyBonus = Math.min(5, perfectStreak - 1);
        score += consistencyBonus;
        bonuses.push({
          type: 'consistency',
          delta: consistencyBonus,
          detail: 'Sequência consistente',
        });
      }
    }

    if (errorStreak > 1) {
      var recoveryPenalty = Math.min(4, errorStreak - 1);
      score -= recoveryPenalty;
      penalties.push({
        type: 'consistency',
        delta: -recoveryPenalty,
        detail: 'Sequência instável',
      });
    }

    return {
      score: clamp(score, 0, 100),
      penalties: penalties,
      bonuses: bonuses,
      consistencyBonus: consistencyBonus,
      weights: weights,
      pitchAnalysis: pitchAnalysis,
      settings: settings.scoring,
    };
  }

  function hasActiveMicrophone(statuses) {
    if (!Array.isArray(statuses) || !statuses.length) {
      return false;
    }

    return statuses.some(function (status) {
      if (status && typeof status === 'object') {
        if (status.statusCode) {
          return normalizeToken(status.statusCode) !== normalizeToken('paused');
        }

        if (status.status) {
          return normalizeToken(status.status) !== normalizeToken(settings.playback.pausedStatus);
        }
      }

      var normalized = normalizeToken(status);
      return normalized && normalized !== normalizeToken(settings.playback.pausedStatus);
    });
  }

  function rankProfiles(profiles) {
    return profiles
      .slice()
      .sort(function (left, right) {
        if (right.bestScore !== left.bestScore) {
          return right.bestScore - left.bestScore;
        }
        return right.totalScore - left.totalScore;
      });
  }

  return {
    clamp: clamp,
    formatTime: formatTime,
    parseLyrics: parseLyrics,
    decorateLine: decorateLine,
    getNeighborLines: getNeighborLines,
    getActiveWord: getActiveWord,
    getActiveLine: getActiveLine,
    normalizeSong: normalizeSong,
    normalizeLibrary: normalizeLibrary,
    scoreSession: scoreSession,
    evaluateVoiceHit: evaluateVoiceHit,
    evaluatePerformanceScore: evaluatePerformanceScore,
    analyzePitchMatch: analyzePitchMatch,
    hasActiveMicrophone: hasActiveMicrophone,
    rankProfiles: rankProfiles,
    estimateDuration: estimateDuration,
    formatPitchGuideLabel: formatPitchGuideLabel,
    settings: settings,
  };
});
