/* eslint-disable no-var, no-undef, no-unused-vars, indent, no-empty */
(function () {
  'use strict';

  var core = window.KaraokeCore;
  var appConfig = window.KaraokeSettings || core.settings || {
    playback: {
      blockedStatus: 'Aguardando microfone pausado',
      readyStatus: 'Pronto para tocar',
      syncingStatus: 'Sincronizando voz',
      pausedStatus: 'Microfone pausado',
    },
    voice: {
      browserHint: 'Chrome ou Edge',
    },
  };
  var storageKey = 'karaoke-family-hub:v1';
  var audioCache = [];
  var stageTimer = null;
  var speechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var audioContextCtor = window.AudioContext || window.webkitAudioContext || null;

  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10);
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ''));
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsText(file);
    });
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return fallback;
    }
  }

  function fileKey(file) {
    return file.webkitRelativePath || file.name;
  }

  function buildFileMap(files) {
    var map = {};
    Array.prototype.forEach.call(files, function (file) {
      map[fileKey(file)] = file;
      map[file.name] = file;
    });
    return map;
  }

  function normalizeSongKey(song) {
    return [song && song.id, song && song.title, song && song.artist]
      .map(function (value) {
        return String(value || '').trim().toLowerCase();
      })
      .join('::');
  }

  function createImportReport(payload) {
    var songs = Array.isArray(payload && payload.songs) ? payload.songs : [];
    var issues = [];

    if (!songs.length) {
      issues.push('Nenhuma faixa encontrada no manifesto.');
    }

    songs.forEach(function (song, index) {
      if (!song || (!song.id && !song.title)) {
        issues.push('Faixa ' + (index + 1) + ' sem id ou titulo.');
      }

      if (song && song.lyricsPath && !song.lyrics && !song.lyricsText) {
        issues.push('Faixa ' + (song.title || index + 1) + ' referencia lyricsPath sem texto carregado.');
      }
    });

    return {
      valid: !issues.length,
      issues: issues,
      count: songs.length,
    };
  }

  function mergeImportedSongs(existingSongs, incomingSongs) {
    var merged = existingSongs.slice();
    var seen = {};
    var replacedCount = 0;

    merged.forEach(function (song) {
      seen[normalizeSongKey(song)] = true;
    });

    incomingSongs.forEach(function (song) {
      var key = normalizeSongKey(song);
      if (seen[key]) {
        merged = merged.filter(function (entry) {
          return normalizeSongKey(entry) !== key;
        });
        replacedCount += 1;
      }
      seen[key] = true;
      merged.unshift(song);
    });

    return {
      songs: merged,
      replacedCount: replacedCount,
    };
  }

  function hzToCents(sourceHz, targetHz) {
    if (!Number.isFinite(sourceHz) || !Number.isFinite(targetHz) || sourceHz <= 0 || targetHz <= 0) {
      return null;
    }

    return Math.round((1200 * Math.log(sourceHz / targetHz)) / Math.log(2));
  }

  function estimatePitchFromBuffer(buffer, sampleRate) {
    var size = buffer.length;
    var rms = 0;
    var minLag;
    var maxLag;
    var bestLag = -1;
    var bestCorrelation = 0;

    for (var index = 0; index < size; index += 1) {
      rms += buffer[index] * buffer[index];
    }

    rms = Math.sqrt(rms / size);
    if (rms < 0.01) {
      return null;
    }

    minLag = Math.max(2, Math.floor(sampleRate / 1000));
    maxLag = Math.min(size - 1, Math.floor(sampleRate / 60));

    for (var lag = minLag; lag <= maxLag; lag += 1) {
      var correlation = 0;
      var limit = size - lag;

      for (var sampleIndex = 0; sampleIndex < limit; sampleIndex += 1) {
        correlation += buffer[sampleIndex] * buffer[sampleIndex + lag];
      }

      correlation /= limit;

      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestCorrelation < 0.15) {
      return null;
    }

    return sampleRate / bestLag;
  }

  function describePitchDelta(deltaCents, toleranceCents) {
    if (!Number.isFinite(deltaCents)) {
      return 'Sem leitura de tom';
    }

    if (Math.abs(deltaCents) <= toleranceCents) {
      return 'Tom alinhado';
    }

    return deltaCents > 0 ? 'Tom acima do alvo' : 'Tom abaixo do alvo';
  }

  function summarizePenalties(penalties) {
    if (!penalties || !penalties.length) {
      return 'Nenhuma penalidade aplicada';
    }

    return penalties
      .map(function (penalty) {
        return penalty.detail + ' (' + penalty.delta + ')';
      })
      .join(' • ');
  }

  function summarizeBonuses(bonuses) {
    if (!bonuses || !bonuses.length) {
      return 'Nenhum bônus aplicado';
    }

    return bonuses
      .map(function (bonus) {
        return bonus.detail + ' (+' + bonus.delta + ')';
      })
      .join(' â€¢ ');
  }

  function loadStoredState() {
    var stored = safeJsonParse(window.localStorage.getItem(storageKey), null);
    return stored || {};
  }

  function saveStoredState(state) {
    var serializable = {
      profiles: state.profiles,
      history: state.history,
      library: state.library.map(function (song) {
        return {
          id: song.id,
          title: song.title,
          artist: song.artist,
          genre: song.genre,
          mode: song.mode,
          audioUrl: song.audioUrl,
          lyrics: song.lyricsText || '',
          duration: song.duration,
          lyricsText: song.lyricsText || '',
          pitchGuideHz: song.pitchGuideHz,
          pitchGuideLabel: song.pitchGuideLabel,
        };
      }),
      selectedSongId: state.currentSong && state.currentSong.id,
      librarySourceLabel: state.librarySourceLabel,
    };

    window.localStorage.setItem(storageKey, JSON.stringify(serializable));
  }

  function createDemoLibrary() {
    return [
      core.normalizeSong({
        id: 'casa-de-cantoria',
        title: 'Casa de Cantoria',
        artist: 'Família Solar',
        genre: 'Pop caseiro',
        mode: 'solo',
        pitchGuideHz: 220,
        lyrics:
          '[00:00.00]Hoje a sala vira palco\n[00:04.10]Cada riso acende a canção\n[00:08.20]O refrão chama a família\n[00:12.40]No compasso do coração\n[00:16.80]Vai, vai, deixa a voz brilhar\n[00:21.10]Aqui ninguém para de cantar',
      }),
      core.normalizeSong({
        id: 'dueto-da-varanda',
        title: 'Dueto da Varanda',
        artist: 'Luna e Theo',
        genre: 'Dueto pop',
        mode: 'duet',
        pitchGuideHz: 246.94,
        lyrics:
          '[00:00.00]Quando a noite acende o céu\n[00:03.60]Tua voz encontra a minha mão\n[00:07.20]Se a melodia pede resposta\n[00:10.80]A gente canta em união\n[00:14.40]E o refrão sobe mais alto\n[00:18.10]Como um abraço em som',
      }),
    ];
  }

  function createDefaultProfiles() {
    return [
      { id: uid('profile'), nickname: 'Nina', emoji: '🎤', color: '#ff8a3d', bestScore: 84, totalScore: 246, sessionCount: 4, modeLabel: 'Solo', selected: false },
      { id: uid('profile'), nickname: 'Bia', emoji: '✨', color: '#33d6c6', bestScore: 92, totalScore: 310, sessionCount: 6, modeLabel: 'Dueto', selected: false },
      { id: uid('profile'), nickname: 'Davi', emoji: '🔥', color: '#ffd84d', bestScore: 77, totalScore: 188, sessionCount: 3, modeLabel: 'Solo', selected: false },
    ];
  }

  angular.module('karaokeFamilyHub', []).controller('KaraokeController', [
    '$scope',
    '$timeout',
    function ($scope, $timeout) {
      var vm = this;
      var stored = loadStoredState();
      var playingAnimation = null;

      vm.searchTerm = '';
      vm.performanceOffset = 0;
      vm.playing = false;
      vm.liveScore = 0;
      vm.scoreHint = 'Prepare o palco e escolha quem vai cantar.';
      vm.timingGrade = 'Pronto';
      vm.modeLabel = 'Solo';
      vm.librarySourceLabel = 'Demo local';
      vm.importStatus = 'Pronto para importar repertório.';
      vm.importIssues = [];
      vm.importedSongCount = 0;
      vm.replacedSongCount = 0;
      vm.importedAudioUrls = [];
      vm.newProfile = {
        nickname: '',
        emoji: '🎤',
      };
      vm.profiles = stored.profiles && stored.profiles.length ? stored.profiles : createDefaultProfiles();
      vm.history = stored.history || [];
      vm.library = stored.library && stored.library.length ? core.normalizeLibrary(stored.library) : createDemoLibrary();
      vm.filteredLibrary = [];
      vm.currentSong = vm.library[0];
      vm.songEditor = {
        title: vm.currentSong.title,
        artist: vm.currentSong.artist,
        genre: vm.currentSong.genre,
        mode: vm.currentSong.mode,
        pitchGuideHz: vm.currentSong.pitchGuideHz || '',
        pitchGuideLabel: vm.currentSong.pitchGuideLabel || '',
      };
      vm.currentTime = 0;
      vm.currentTimeLabel = '00:00';
      vm.progressPercent = 0;
      vm.selectedProfiles = [];
      vm.selectedProfileNames = 'Nenhum';
      vm.activeLine = { text: '', words: [] };
      vm.previousLine = null;
      vm.nextLine = null;
      vm.activeLineLabel = 'Leitura inicial';
      vm.ranking = [];
      vm.scoreHint = 'Escolha uma faixa e ajuste o offset de sintonia.';
      vm.voiceSyncActive = false;
      vm.voiceSyncSupported = !!speechRecognitionCtor;
      vm.pitchAnalysisSupported = !!navigator.mediaDevices && !!audioContextCtor;
      vm.microphones = [
        {
          id: 'mic-1',
          label: 'Microfone 1',
          status: 'Microfone pausado',
          statusCode: 'paused',
          mode: 'idle',
        },
      ];
      vm.voiceSyncStatus = speechRecognitionCtor
        ? 'Pronto para ouvir o microfone.'
        : 'SpeechRecognition indisponivel neste navegador. Use ' + appConfig.voice.browserHint + '.';
      vm.playbackGateState = 'ready';
      vm.playbackGateMessage = appConfig.playback.readyStatus;
      vm.voiceScoreDelta = 0;
      vm.performanceScore = 100;
      vm.performancePenalties = [];
      vm.performanceBonuses = [];
      vm.performancePerfectStreak = 0;
      vm.performanceErrorStreak = 0;
      vm.performanceDbDelta = null;
      vm.performancePenaltySummary = 'Nenhuma penalidade aplicada';
      vm.performanceBonusSummary = 'Nenhum bônus aplicado';
      vm.performanceSummary = 'Pronto para avaliar timing e pitch.';
      vm.pitchDetectedHz = null;
      vm.pitchReferenceHz = null;
      vm.pitchDeltaCents = null;
      vm.pitchGrade = 'Sem leitura';
      vm.pitchStatus = vm.pitchAnalysisSupported
        ? 'Tom pronto para leitura.'
        : 'Pitch indisponivel neste navegador.';
      vm.pitchCalibrationPending = false;
      vm.pitchCalibrationStatus = 'Sem calibração ativa.';
      vm.pitchMonitorActive = false;
      vm.pitchMonitorStatus = vm.pitchAnalysisSupported
        ? 'Aguardando leitura do microfone.'
        : 'Leitura de tom indisponivel.';
      vm.voiceAlerts = [];
      vm.currentVoiceWord = '-';
      vm.currentVoiceTranscript = '';
      vm.baseScore = 0;
      vm.lastVoiceEvent = null;
      vm.pitchAudioContext = null;
      vm.pitchAnalyser = null;
      vm.pitchMediaStream = null;
      vm.pitchSource = null;
      vm.pitchTimer = null;

      function pushVoiceAlert(message, delta) {
        vm.voiceAlerts.unshift({
          id: uid('voice'),
          message: message,
          delta: delta,
          timeLabel: vm.currentTimeLabel,
        });
        vm.voiceAlerts = vm.voiceAlerts.slice(0, 5);
      }

      function resetVoiceSession() {
        vm.voiceScoreDelta = 0;
        vm.voiceAlerts = [];
        vm.currentVoiceWord = '-';
        vm.currentVoiceTranscript = '';
        vm.lastVoiceEvent = null;
      }

      function refreshSongEditor(song) {
        var pitchGuideHz = Number(song && song.pitchGuideHz);

        vm.songEditor = {
          title: song && song.title ? song.title : '',
          artist: song && song.artist ? song.artist : '',
          genre: song && song.genre ? song.genre : '',
          mode: song && song.mode ? song.mode : 'solo',
          pitchGuideHz: Number.isFinite(pitchGuideHz) && pitchGuideHz > 0 ? String(pitchGuideHz) : '',
          pitchGuideLabel: song && song.pitchGuideLabel ? song.pitchGuideLabel : '',
        };
      }

      function downloadJsonFile(filename, payload) {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = window.URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(function () {
          window.URL.revokeObjectURL(url);
        }, 250);
      }

      function getPitchTargetHz() {
        var pitchGuideHz = Number(vm.currentSong && vm.currentSong.pitchGuideHz);
        return Number.isFinite(pitchGuideHz) && pitchGuideHz > 0 ? pitchGuideHz : null;
      }

      function applyPitchCalibration(detectedHz) {
        var label = core.formatPitchGuideLabel(detectedHz);

        if (!vm.currentSong || !Number.isFinite(detectedHz) || detectedHz <= 0) {
          return;
        }

        vm.currentSong.pitchGuideHz = detectedHz;
        vm.currentSong.pitchGuideLabel = label;
        vm.pitchReferenceHz = detectedHz;
        vm.pitchDetectedHz = detectedHz;
        vm.pitchDeltaCents = 0;
        vm.pitchGrade = 'Tom calibrado';
        vm.pitchStatus = 'Tom de referencia ajustado para ' + detectedHz.toFixed(1) + ' Hz' + (label ? ' (' + label + ')' : '');
        vm.pitchCalibrationPending = false;
        vm.pitchCalibrationStatus = 'Calibrado em ' + detectedHz.toFixed(1) + ' Hz' + (label ? ' (' + label + ')' : '');
        vm.pitchMonitorStatus = 'Tom de referencia gravado.';
        vm.performanceDbDelta = null;
        saveStoredState(vm);
      }

      function resetPitchSession() {
        vm.pitchDetectedHz = null;
        vm.pitchReferenceHz = getPitchTargetHz();
        vm.pitchDeltaCents = null;
        vm.pitchGrade = 'Sem leitura';
        vm.pitchStatus = vm.pitchReferenceHz
          ? 'Tom pronto para leitura.'
          : 'Tom sem referencia local.';
        vm.pitchMonitorStatus = vm.pitchAnalysisSupported
          ? 'Aguardando leitura do microfone.'
          : 'Leitura de tom indisponivel.';
        vm.pitchCalibrationPending = false;
        vm.pitchCalibrationStatus = vm.pitchReferenceHz
          ? 'Tom de referencia definido em ' + vm.pitchReferenceHz.toFixed(1) + ' Hz.'
          : 'Sem calibracao ativa.';
        vm.performancePenalties = [];
        vm.performanceBonuses = [];
        vm.performancePerfectStreak = 0;
        vm.performanceErrorStreak = 0;
        vm.performanceDbDelta = null;
        vm.performancePenaltySummary = 'Nenhuma penalidade aplicada';
        vm.performanceBonusSummary = 'Nenhum bônus aplicado';
        vm.performanceSummary = 'Pronto para avaliar timing e pitch.';
      }

      function stopPitchMonitoring() {
        if (vm.pitchTimer) {
          window.clearInterval(vm.pitchTimer);
          vm.pitchTimer = null;
        }

        if (vm.pitchAnalyser) {
          try {
            vm.pitchAnalyser.disconnect();
          } catch (error) {}
          vm.pitchAnalyser = null;
        }

        if (vm.pitchSource) {
          try {
            vm.pitchSource.disconnect();
          } catch (error) {}
          vm.pitchSource = null;
        }

        if (vm.pitchAudioContext) {
          try {
            vm.pitchAudioContext.close();
          } catch (error) {}
          vm.pitchAudioContext = null;
        }

        if (vm.pitchMediaStream) {
          vm.pitchMediaStream.getTracks().forEach(function (track) {
            try {
              track.stop();
            } catch (error) {}
          });
          vm.pitchMediaStream = null;
        }

        vm.pitchMonitorActive = false;
        vm.pitchMonitorStatus = vm.pitchAnalysisSupported
          ? 'Leitura de tom pausada.'
          : 'Leitura de tom indisponivel.';
      }

      function samplePitchMonitoring() {
        var targetHz;
        var pitchBuffer;
        var detectedHz;
        var nextDelta;

        if (!vm.pitchAnalyser || !vm.pitchAudioContext || !vm.playing) {
          return;
        }

        pitchBuffer = new Float32Array(vm.pitchAnalyser.fftSize);
        vm.pitchAnalyser.getFloatTimeDomainData(pitchBuffer);
        detectedHz = estimatePitchFromBuffer(pitchBuffer, vm.pitchAudioContext.sampleRate);
        targetHz = getPitchTargetHz();
        vm.pitchReferenceHz = targetHz;

        if (vm.pitchCalibrationPending && detectedHz) {
          applyPitchCalibration(detectedHz);
          updateScoreState(getBaseScoreResult());
          $scope.$applyAsync();
          return;
        }

        if (detectedHz && targetHz) {
          nextDelta = hzToCents(detectedHz, targetHz);
          vm.pitchDetectedHz = detectedHz;
          vm.pitchDeltaCents = nextDelta;
          vm.pitchGrade = describePitchDelta(nextDelta, appConfig.scoring.pitchToleranceCents);
          vm.pitchStatus =
            vm.pitchGrade + ' • alvo ' + targetHz.toFixed(1) + ' Hz • leitura ' + detectedHz.toFixed(1) + ' Hz';
          vm.pitchMonitorStatus = 'Tom detectado em ' + detectedHz.toFixed(1) + ' Hz.';
        } else if (detectedHz) {
          vm.pitchDetectedHz = detectedHz;
          vm.pitchDeltaCents = null;
          vm.pitchGrade = 'Sem referencia';
          vm.pitchStatus = 'Tom detectado sem referencia local.';
          vm.pitchMonitorStatus = 'Tom detectado em ' + detectedHz.toFixed(1) + ' Hz.';
        } else {
          vm.pitchDetectedHz = null;
          vm.pitchDeltaCents = null;
          vm.pitchGrade = 'Sem leitura';
          vm.pitchStatus = vm.pitchReferenceHz ? 'Sem leitura de tom' : 'Tom sem referencia local.';
          vm.pitchMonitorStatus = 'Aguardando leitura limpa do microfone.';
        }

        updateScoreState(getBaseScoreResult());
        $scope.$applyAsync();
      }

      function startPitchMonitoring() {
        if (!vm.pitchAnalysisSupported || !vm.playing || vm.pitchTimer) {
          return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          vm.pitchMonitorStatus = 'Leitura de tom indisponivel neste navegador.';
          return;
        }

        navigator.mediaDevices
          .getUserMedia({ audio: true, video: false })
          .then(function (stream) {
            if (!vm.playing || !vm.voiceSyncActive) {
              stream.getTracks().forEach(function (track) {
                try {
                  track.stop();
                } catch (error) {}
              });
              return;
            }

            vm.pitchMediaStream = stream;
            vm.pitchAudioContext = new audioContextCtor();
            vm.pitchSource = vm.pitchAudioContext.createMediaStreamSource(stream);
            vm.pitchAnalyser = vm.pitchAudioContext.createAnalyser();
            vm.pitchAnalyser.fftSize = 2048;
            vm.pitchSource.connect(vm.pitchAnalyser);
            vm.pitchTimer = window.setInterval(samplePitchMonitoring, 140);
            vm.pitchMonitorActive = true;
            vm.pitchMonitorStatus = 'Leitura de tom ativa.';
            $scope.$applyAsync();
          })
          .catch(function (error) {
            vm.pitchMonitorStatus = 'Leitura de tom indisponivel: ' + (error && error.name ? error.name : 'erro');
            vm.pitchMonitorActive = false;
            $scope.$applyAsync();
          });
      }

      function refreshPlaybackGateState() {
        if (vm.voiceSyncActive) {
          vm.playbackGateState = 'syncing';
          vm.playbackGateMessage = appConfig.playback.syncingStatus;
          return;
        }

        if (canStartPlayback()) {
          vm.playbackGateState = 'ready';
          vm.playbackGateMessage = appConfig.playback.readyStatus;
          return;
        }

        vm.playbackGateState = 'blocked';
        vm.playbackGateMessage = appConfig.playback.blockedStatus;
      }

      function updateScoreState(result) {
        var performance;
        var baseScore = result.score;
        var hasPerformanceSignal = vm.performanceOffset !== 0 || Number.isFinite(vm.pitchDeltaCents);

        performance = core.evaluatePerformanceScore({
          timingDeltaMs: vm.performanceOffset,
          pitchDeltaCents: vm.pitchDeltaCents,
          dbDelta: vm.performanceDbDelta,
          mode: result.mode,
          profileCount: vm.selectedProfiles.length || 1,
          perfectStreak: vm.performancePerfectStreak,
          errorStreak: vm.performanceErrorStreak,
        });

        var performanceDelta = hasPerformanceSignal ? performance.score - 100 : 0;
        var finalScore = core.clamp(baseScore + vm.voiceScoreDelta + performanceDelta, 0, 100);

        if (hasPerformanceSignal) {
          if (performance.penalties.length) {
            vm.performanceErrorStreak += 1;
            vm.performancePerfectStreak = 0;
          } else {
            vm.performancePerfectStreak += 1;
            vm.performanceErrorStreak = 0;
          }
        }

        vm.baseScore = baseScore;
        vm.performanceScore = performance.score;
        vm.performancePenalties = performance.penalties;
        vm.performanceBonuses = performance.bonuses;
        vm.performancePenaltySummary = summarizePenalties(performance.penalties);
        vm.performanceBonusSummary = summarizeBonuses(performance.bonuses);
        vm.performanceSummary = performance.penalties.length
          ? vm.performancePenaltySummary
          : vm.performanceBonusSummary;
        vm.liveScore = finalScore;
        vm.timingGrade = result.timingGrade;
        vm.scoreHint = result.hint + ' ' + vm.performanceSummary;
        vm.modeLabel = result.mode;
        vm.pitchGrade = describePitchDelta(vm.pitchDeltaCents, appConfig.scoring.pitchToleranceCents);
        refreshPlaybackGateState();
      }

      function getBaseScoreResult() {
        return core.scoreSession({
          progress: vm.currentSong.duration ? vm.currentTime / vm.currentSong.duration : 0,
          offsetMs: vm.performanceOffset,
          profileCount: vm.selectedProfiles.length || 1,
        });
      }

      function getMicrophoneStatuses() {
        return vm.microphones.map(function (microphone) {
          return {
            status: microphone.status,
            statusCode: microphone.statusCode,
          };
        });
      }

      function canStartPlayback() {
        return vm.voiceSyncActive || !core.hasActiveMicrophone(getMicrophoneStatuses());
      }

      function getCurrentActiveWord() {
        var activeLine = vm.activeLine && vm.activeLine.words ? vm.activeLine : null;
        return core.getActiveWord(activeLine, vm.currentTime);
      }

      function applyVoiceHit(transcript) {
        if (!vm.currentSong || !vm.playing) {
          return null;
        }

        var activeWord = getCurrentActiveWord();
        if (!activeWord) {
          vm.currentVoiceTranscript = transcript;
          vm.currentVoiceWord = '-';
          return null;
        }

        var evaluation = core.evaluateVoiceHit({
          transcript: transcript,
          activeWord: activeWord,
          currentTime: vm.currentTime,
          toleranceMs: 450,
        });

        if (evaluation.status === 'idle') {
          return null;
        }

        vm.currentVoiceTranscript = transcript;
        vm.currentVoiceWord = activeWord.text;
        vm.lastVoiceEvent = evaluation;

        if (evaluation.delta !== 0) {
          vm.voiceScoreDelta += evaluation.delta;
          pushVoiceAlert(evaluation.message, evaluation.delta);
        }

        vm.voiceScoreDelta = Math.max(-999, vm.voiceScoreDelta);
        updateScoreState(getBaseScoreResult());
        vm.voiceSyncStatus = evaluation.message;
        vm.microphones[0].status = vm.voiceSyncActive ? 'Escutando' : 'Microfone pausado';
        vm.microphones[0].mode = vm.voiceSyncActive ? 'sync' : 'idle';
        refreshPlaybackGateState();
        return evaluation;
      }

      function stopTimer() {
        if (playingAnimation) {
          window.clearInterval(playingAnimation);
          playingAnimation = null;
        }
      }

      function syncAudio(song) {
        if (audioCache.length) {
          audioCache.forEach(function (audio) {
            try {
              audio.pause();
            } catch (error) {}
          });
        }

        if (!song.audioUrl) {
          return null;
        }

        var audio = new Audio(song.audioUrl);
        audio.preload = 'auto';
        audioCache.push(audio);
        return audio;
      }

      function createVoiceRecognition() {
        if (!speechRecognitionCtor) {
          return null;
        }

        if (window.__karaokeVoiceRecognition) {
          return window.__karaokeVoiceRecognition;
        }

        var recognition = new speechRecognitionCtor();
        recognition.lang = 'pt-BR';
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = function () {
          vm.voiceSyncActive = true;
          vm.voiceSyncStatus = 'Microfone ativo. Cante a palavra em foco.';
          vm.microphones[0].status = 'Escutando';
          vm.microphones[0].statusCode = 'active';
          vm.microphones[0].mode = 'sync';
          startPitchMonitoring();
          refreshPlaybackGateState();
          $scope.$applyAsync();
        };

        recognition.onresult = function (event) {
          var index;
          for (index = event.resultIndex; index < event.results.length; index += 1) {
            if (event.results[index].isFinal) {
              applyVoiceHit(event.results[index][0].transcript);
            }
          }
          $scope.$applyAsync();
        };

        recognition.onerror = function (event) {
          vm.voiceSyncStatus = 'Erro no microfone: ' + event.error;
          vm.voiceSyncActive = false;
          vm.microphones[0].status = 'Microfone pausado';
          vm.microphones[0].statusCode = 'paused';
          vm.microphones[0].mode = 'idle';
          stopPitchMonitoring();
          refreshPlaybackGateState();
          $scope.$applyAsync();
        };

        recognition.onend = function () {
          if (vm.voiceSyncActive) {
            window.setTimeout(function () {
              try {
                recognition.start();
              } catch (error) {}
            }, 250);
            return;
          }

          vm.voiceSyncStatus = 'Microfone pausado.';
          vm.microphones[0].status = 'Microfone pausado';
          vm.microphones[0].statusCode = 'paused';
          vm.microphones[0].mode = 'idle';
          stopPitchMonitoring();
          refreshPlaybackGateState();
          $scope.$applyAsync();
        };

        window.__karaokeVoiceRecognition = recognition;
        return recognition;
      }

      function stopVoiceRecognition() {
        var recognition = window.__karaokeVoiceRecognition;
        if (!recognition) {
          return;
        }

        vm.voiceSyncActive = false;
        try {
          recognition.stop();
        } catch (error) {}
        vm.voiceSyncStatus = 'Microfone pausado.';
        vm.microphones[0].status = 'Microfone pausado';
        vm.microphones[0].statusCode = 'paused';
        vm.microphones[0].mode = 'idle';
        stopPitchMonitoring();
        refreshPlaybackGateState();
      }

      function refreshMode() {
        vm.modeLabel = vm.selectedProfiles.length >= 2 ? 'Dueto' : 'Solo';
        vm.selectedProfileNames = vm.selectedProfiles.length
          ? vm.selectedProfiles.map(function (profile) {
              return profile.nickname;
            }).join(', ')
          : 'Nenhum';

        vm.profiles.forEach(function (profile) {
          profile.selected = vm.selectedProfiles.some(function (selected) {
            return selected.id === profile.id;
          });
        });
      }

      function updateLyrics() {
        var time = vm.currentTime;
        var neighbors = core.getNeighborLines(vm.currentSong.lyrics, time);
        var activeWord;
        vm.previousLine = neighbors.previous;
        vm.nextLine = neighbors.next;
        vm.activeLine = core.decorateLine(neighbors.current, time) || { text: '', words: [] };
        vm.activeLineLabel = neighbors.current ? core.formatTime(neighbors.current.start) + ' focado' : 'Sem trecho ativo';
        activeWord = getCurrentActiveWord();
        vm.currentVoiceWord = activeWord ? activeWord.text : '-';
      }

      function finalizeSession() {
        if (!vm.currentSong) {
          return;
        }

        var result = getBaseScoreResult();
        updateScoreState(result);

        var participants = vm.selectedProfiles.length ? vm.selectedProfiles : [{ nickname: 'Solo', id: 'solo' }];
        participants.forEach(function (profile) {
          if (profile.id === 'solo') {
            return;
          }

          profile.totalScore = (Number(profile.totalScore) || 0) + vm.liveScore;
          profile.sessionCount = (Number(profile.sessionCount) || 0) + 1;
          profile.bestScore = Math.max(Number(profile.bestScore) || 0, vm.liveScore);
          profile.modeLabel = result.mode;
        });

        vm.history.unshift({
          id: uid('session'),
          songTitle: vm.currentSong.title,
          score: vm.liveScore,
          mode: result.mode,
          participants: participants.map(function (profile) {
            return profile.nickname;
          }),
          playedAt: new Date().toISOString(),
        });

        vm.ranking = core.rankProfiles(vm.profiles).slice(0, 5);
        saveStoredState(vm);
      }

      function tick() {
        var duration = vm.currentSong.duration || 0;
        if (!duration) {
          return;
        }

        vm.currentTime = Math.min(duration, vm.currentTime + 0.1);
        vm.currentTimeLabel = core.formatTime(vm.currentTime);
        vm.progressPercent = duration ? (vm.currentTime / duration) * 100 : 0;
        updateLyrics();
        updateScoreState(getBaseScoreResult());

        if (vm.currentTime >= duration) {
          vm.playing = false;
          stopTimer();
          stopVoiceRecognition();
          finalizeSession();
          $scope.$applyAsync();
        } else {
          $scope.$applyAsync();
        }
      }

      vm.refreshLibrary = function () {
        var term = String(vm.searchTerm || '').toLowerCase().trim();
        vm.filteredLibrary = vm.library.filter(function (song) {
          if (!term) {
            return true;
          }

          return (
            song.title.toLowerCase().includes(term) ||
            song.artist.toLowerCase().includes(term) ||
            song.genre.toLowerCase().includes(term) ||
            song.modeLabel.toLowerCase().includes(term)
          );
        });

        if (!vm.filteredLibrary.length) {
          vm.filteredLibrary = vm.library.slice();
        }
      };

      vm.refreshScore = function () {
        updateScoreState(getBaseScoreResult());
      };

      vm.applySongEdits = function () {
        var pitchGuideHz = Number(vm.songEditor.pitchGuideHz);

        if (!vm.currentSong) {
          return;
        }

        vm.currentSong.title = String(vm.songEditor.title || vm.currentSong.title).trim() || vm.currentSong.title;
        vm.currentSong.artist = String(vm.songEditor.artist || vm.currentSong.artist).trim() || vm.currentSong.artist;
        vm.currentSong.genre = String(vm.songEditor.genre || vm.currentSong.genre).trim() || vm.currentSong.genre;
        vm.currentSong.mode = vm.songEditor.mode === 'duet' ? 'duet' : 'solo';

        if (Number.isFinite(pitchGuideHz) && pitchGuideHz > 0) {
          vm.currentSong.pitchGuideHz = pitchGuideHz;
          vm.currentSong.pitchGuideLabel = core.formatPitchGuideLabel(pitchGuideHz);
        } else {
          delete vm.currentSong.pitchGuideHz;
          delete vm.currentSong.pitchGuideLabel;
        }

        refreshSongEditor(vm.currentSong);
        vm.refreshLibrary();
        vm.refreshScore();
        saveStoredState(vm);
      };

      vm.resetSongEditor = function () {
        refreshSongEditor(vm.currentSong);
      };

      vm.exportBackup = function () {
        var librarySnapshot = vm.library.map(function (song) {
          var snapshot = Object.assign({}, song);
          if (String(snapshot.audioUrl || '').indexOf('blob:') === 0) {
            snapshot.audioUrl = '';
          }
          return snapshot;
        });

        downloadJsonFile('karaoke-family-hub-backup.json', {
          exportedAt: new Date().toISOString(),
          profiles: vm.profiles,
          history: vm.history,
          library: librarySnapshot,
          selectedSongId: vm.currentSong && vm.currentSong.id,
          librarySourceLabel: vm.librarySourceLabel,
        });
        vm.importStatus = 'Backup exportado com sucesso.';
      };

      vm.triggerBackupImport = function () {
        var input = document.getElementById('backupInput');
        if (input) {
          input.value = '';
          input.click();
        }
      };

      vm.handleBackupImport = function (files) {
        var file = files && files[0];

        if (!file) {
          vm.importStatus = 'Selecione um arquivo de backup valido.';
          $scope.$applyAsync();
          return;
        }

        readText(file)
          .then(function (text) {
            var payload = safeJsonParse(text, null);
            var importedLibrary;

            if (!payload || !Array.isArray(payload.library)) {
              throw new Error('Backup invalido.');
            }

            importedLibrary = core.normalizeLibrary(payload.library);
            importedLibrary = importedLibrary.map(function (song) {
              if (String(song.audioUrl || '').indexOf('blob:') === 0) {
                song.audioUrl = '';
              }
              return song;
            });
            vm.profiles = Array.isArray(payload.profiles) && payload.profiles.length ? payload.profiles : createDefaultProfiles();
            vm.history = Array.isArray(payload.history) ? payload.history : [];
            vm.library = importedLibrary;
            vm.filteredLibrary = vm.library.slice();
            vm.librarySourceLabel = payload.librarySourceLabel || 'Backup restaurado';
            vm.currentSong = vm.library.find(function (song) {
              return song.id === payload.selectedSongId;
            }) || vm.library[0];
            refreshSongEditor(vm.currentSong);
            vm.selectedProfiles = [];
            refreshMode();
            vm.ranking = core.rankProfiles(vm.profiles).slice(0, 5);
            resetVoiceSession();
            resetPitchSession();
            stopVoiceRecognition();
            stopPitchMonitoring();
            updateLyrics();
            vm.refreshScore();
            saveStoredState(vm);
            vm.importStatus = 'Backup restaurado com sucesso.';
            $scope.$applyAsync();
          })
          .catch(function (error) {
            vm.importStatus = 'Falha ao restaurar backup: ' + (error && error.message ? error.message : 'erro desconhecido');
            $scope.$applyAsync();
          });
      };

      vm.togglePitchCalibration = function () {
        if (!vm.pitchAnalysisSupported) {
          vm.pitchCalibrationStatus = 'Pitch indisponivel neste navegador.';
          return;
        }

        if (!vm.voiceSyncActive) {
          vm.pitchCalibrationStatus = 'Ative a sincronizacao de voz antes de calibrar o tom.';
          return;
        }

        vm.pitchCalibrationPending = !vm.pitchCalibrationPending;
        if (vm.pitchCalibrationPending) {
          vm.pitchCalibrationStatus = 'Calibracao pronta. Cante um tom limpo para gravar a referencia.';
          vm.pitchMonitorStatus = 'Aguardando tom de referencia para calibracao.';
          return;
        }

        vm.pitchCalibrationStatus = vm.pitchReferenceHz
          ? 'Calibracao cancelada. Referencia atual mantida em ' + vm.pitchReferenceHz.toFixed(1) + ' Hz.'
          : 'Calibracao cancelada.';
        vm.pitchMonitorStatus = 'Leitura de tom normal.';
      };

      vm.selectSong = function (song) {
        vm.currentSong = song;
        vm.currentTime = 0;
        vm.currentTimeLabel = '00:00';
        vm.progressPercent = 0;
        vm.playing = false;
        stopTimer();
        resetVoiceSession();
        resetPitchSession();
        stopVoiceRecognition();
        stopPitchMonitoring();

        if (vm.audioInstance) {
          try {
            vm.audioInstance.pause();
          } catch (error) {}
        }

        vm.audioInstance = syncAudio(song);
        refreshSongEditor(vm.currentSong);
        updateLyrics();
        vm.refreshScore();
        saveStoredState(vm);
      };

      vm.restartSong = function () {
        vm.currentTime = 0;
        vm.currentTimeLabel = '00:00';
        vm.progressPercent = 0;
        updateLyrics();
        resetVoiceSession();
        resetPitchSession();
        stopVoiceRecognition();
        stopPitchMonitoring();
        vm.refreshScore();

        if (vm.audioInstance) {
          try {
            vm.audioInstance.currentTime = 0;
          } catch (error) {}
        }
      };

      vm.togglePlayback = function () {
        if (!vm.currentSong) {
          return;
        }

        if (!vm.playing && !canStartPlayback()) {
          vm.voiceSyncStatus = 'Aguarde o microfone pausar antes de iniciar a musica.';
          pushVoiceAlert('Nao iniciou: exista microfone ativo. Pausa obrigatoria antes do play.', -5);
          refreshPlaybackGateState();
          return;
        }

        if (vm.audioInstance) {
          if (vm.playing) {
            vm.audioInstance.pause();
            vm.playing = false;
            stopTimer();
            stopVoiceRecognition();
            stopPitchMonitoring();
            finalizeSession();
            return;
          }

          vm.audioInstance.currentTime = vm.currentTime;
          var playResult = vm.audioInstance.play();
          if (playResult && typeof playResult.then === 'function') {
            playResult
              .then(function () {
                vm.playing = true;
                if (vm.voiceSyncActive) {
                  startPitchMonitoring();
                }
                refreshPlaybackGateState();
                $scope.$applyAsync();
              })
              .catch(function (error) {
                vm.playing = false;
                stopTimer();
                vm.voiceSyncStatus = 'Nao foi possivel tocar a musica: ' + (error && error.message ? error.message : 'erro desconhecido');
                refreshPlaybackGateState();
                $scope.$applyAsync();
              });
          } else {
            vm.playing = true;
          }
          vm.audioInstance.ontimeupdate = function () {
            vm.currentTime = vm.audioInstance.currentTime;
            vm.currentTimeLabel = core.formatTime(vm.currentTime);
            vm.progressPercent = vm.currentSong.duration ? (vm.currentTime / vm.currentSong.duration) * 100 : 0;
            updateLyrics();
            updateScoreState(getBaseScoreResult());
            $scope.$applyAsync();
          };
          vm.audioInstance.onended = function () {
            vm.playing = false;
            stopVoiceRecognition();
            stopPitchMonitoring();
            finalizeSession();
            $scope.$applyAsync();
          };
          if (vm.playing) {
            refreshPlaybackGateState();
            if (vm.voiceSyncActive) {
              startPitchMonitoring();
            }
          }
          return;
        }

        vm.playing = !vm.playing;
        if (vm.playing) {
          stopTimer();
          playingAnimation = window.setInterval(tick, 100);
          if (vm.voiceSyncActive) {
            startPitchMonitoring();
          }
        } else {
          stopTimer();
          stopVoiceRecognition();
          stopPitchMonitoring();
          finalizeSession();
        }
      };

      vm.toggleVoiceSync = function () {
        if (!speechRecognitionCtor) {
          vm.voiceSyncStatus = 'SpeechRecognition indisponivel neste navegador. Use ' + appConfig.voice.browserHint + '.';
          return;
        }

        if (vm.voiceSyncActive) {
          stopVoiceRecognition();
          return;
        }

        var recognition = createVoiceRecognition();
        if (!recognition) {
          vm.voiceSyncStatus = 'Nao foi possivel iniciar o reconhecimento de voz.';
          return;
        }

        vm.voiceSyncStatus = 'Iniciando microfone...';
        try {
          recognition.start();
        } catch (error) {
          vm.voiceSyncStatus = 'Nao foi possivel iniciar o reconhecimento de voz.';
        }
      };

      vm.seekByTimeline = function ($event) {
        var element = $event.currentTarget;
        var rect = element.getBoundingClientRect();
        var progress = (Math.max(0, $event.clientX - rect.left) / rect.width) * 100;
        var nextTime = (progress / 100) * (vm.currentSong.duration || 0);
        vm.currentTime = nextTime;
        vm.currentTimeLabel = core.formatTime(vm.currentTime);
        vm.progressPercent = progress;
        updateLyrics();
        vm.refreshScore();

        if (vm.audioInstance) {
          try {
            vm.audioInstance.currentTime = nextTime;
          } catch (error) {}
        }
      };

      vm.toggleProfile = function (profile) {
        var exists = vm.selectedProfiles.some(function (selected) {
          return selected.id === profile.id;
        });

        if (exists) {
          vm.selectedProfiles = vm.selectedProfiles.filter(function (selected) {
            return selected.id !== profile.id;
          });
        } else {
          vm.selectedProfiles.push(profile);
        }

        refreshMode();
        vm.refreshScore();
      };

      vm.addProfile = function () {
        var nickname = String(vm.newProfile.nickname || '').trim();
        if (!nickname) {
          return;
        }

        vm.profiles.unshift({
          id: uid('profile'),
          nickname: nickname,
          emoji: vm.newProfile.emoji || '🎤',
          color: ['#ff8a3d', '#33d6c6', '#ffd84d', '#d98bff', '#7ed957'][vm.profiles.length % 5],
          bestScore: 0,
          totalScore: 0,
          sessionCount: 0,
          modeLabel: 'Solo',
          selected: false,
        });
        vm.newProfile.nickname = '';
        vm.newProfile.emoji = '🎤';
        vm.ranking = core.rankProfiles(vm.profiles).slice(0, 5);
        saveStoredState(vm);
      };

      vm.triggerImport = function () {
        vm.importStatus = 'Selecione uma pasta com manifest.json/repertory.json ou arquivos .lrc.';
        vm.importIssues = [];
        document.getElementById('repertoryInput').click();
      };

      vm.handleImport = function (files) {
        var fileArray = Array.prototype.slice.call(files || []);
        if (!fileArray.length) {
          vm.importStatus = 'Nenhum arquivo selecionado.';
          return;
        }

        var map = buildFileMap(fileArray);
        var manifest = map['manifest.json'] || map['repertory.json'];
        var manifestPromise = manifest ? readText(manifest).then(function (text) {
          return safeJsonParse(text, null);
        }) : Promise.resolve(null);

        manifestPromise
          .then(function (payload) {
            if (payload && payload.songs) {
              var report = createImportReport(payload);
              if (!report.valid) {
                vm.importStatus = 'Manifesto carregado com avisos.';
                vm.importIssues = report.issues.slice();
              }

              return Promise.all(
                payload.songs.map(function (song) {
                  var lyricsText = song.lyrics || '';
                  var lyricsPath = song.lyricsPath || song.lyricPath;
                  if (lyricsPath && map[lyricsPath]) {
                    return readText(map[lyricsPath]).then(function (text) {
                      return {
                        id: song.id,
                        title: song.title,
                        artist: song.artist,
                        genre: song.genre,
                        mode: song.mode,
                        duration: song.duration,
                        pitchGuideHz: song.pitchGuideHz,
                        pitchGuideLabel: song.pitchGuideLabel,
                        audioPath: song.audioPath || song.audio || song.audioUrl || '',
                        lyrics: text,
                        lyricsText: text,
                      };
                    });
                  }
                  return Promise.resolve({
                    id: song.id,
                    title: song.title,
                    artist: song.artist,
                    genre: song.genre,
                    mode: song.mode,
                    duration: song.duration,
                    pitchGuideHz: song.pitchGuideHz,
                    pitchGuideLabel: song.pitchGuideLabel,
                    audioPath: song.audioPath || song.audio || song.audioUrl || '',
                    lyrics: lyricsText,
                    lyricsText: lyricsText,
                  });
                }),
              ).then(function (songs) {
                return {
                  title: payload.title || 'Repertório importado',
                  songs: songs,
                };
              });
            }

            var inferredSongs = fileArray
              .filter(function (file) {
                return /\.lrc$/i.test(file.name);
              })
              .map(function (file) {
                return readText(file).then(function (text) {
                  var base = file.name.replace(/\.lrc$/i, '');
                  return {
                    id: base,
                    title: base.replace(/[-_]/g, ' '),
                    artist: 'Importado localmente',
                    genre: 'Repertório',
                    mode: 'solo',
                    lyrics: text,
                  };
                });
              });

            if (!inferredSongs.length) {
              vm.importStatus = 'Nenhuma faixa .lrc encontrada na pasta.';
              vm.importIssues = ['Adicione pelo menos um arquivo .lrc ou um manifest.json/repertory.json.'];
              return { songs: [] };
            }

            return Promise.all(inferredSongs).then(function (songs) {
              return {
                title: 'Repertório importado',
                songs: songs,
              };
            });
          })
          .then(function (payload) {
            var imported = core.normalizeLibrary(
              payload.songs.map(function (song) {
                var audioPath = song.audioPath || song.audio || song.audioUrl || '';
                var lyricsPath = song.lyricsPath || '';
                var lyricsText = song.lyrics || song.lyricsText || '';
                var audioFile = audioPath ? map[audioPath] || map[audioPath.replace(/^\.\//, '')] : null;
                var lyricsFile = lyricsPath ? map[lyricsPath] || map[lyricsPath.replace(/^\.\//, '')] : null;
                var audioUrl = audioFile ? URL.createObjectURL(audioFile) : '';

                if (audioUrl) {
                  vm.importedAudioUrls.push(audioUrl);
                }

                return {
                  id: song.id || uid('song'),
                  title: song.title || 'Faixa importada',
                  artist: song.artist || 'Local',
                  genre: song.genre || 'Karaoke',
                  mode: song.mode || 'solo',
                  pitchGuideHz: song.pitchGuideHz,
                  pitchGuideLabel: song.pitchGuideLabel,
                  audioUrl: audioUrl,
                  duration: song.duration,
                  lyrics: lyricsFile ? '' : lyricsText,
                  lyricsText: lyricsText,
                };
              }),
            );

            var merged = mergeImportedSongs(vm.library, imported);
            vm.library = merged.songs;
            vm.librarySourceLabel = payload.title || 'Repertório importado';
            vm.importedSongCount = imported.length;
            vm.replacedSongCount = merged.replacedCount;
            vm.importStatus = merged.replacedCount
              ? 'Repertório importado com substituição de ' + merged.replacedCount + ' faixa(s) duplicada(s).'
              : 'Repertório importado com sucesso.';
            vm.refreshLibrary();
            if (vm.library[0]) {
              vm.selectSong(vm.library[0]);
            }
            saveStoredState(vm);
            $scope.$applyAsync();
          })
          .catch(function (error) {
            console.error('Falha ao importar repertório', error);
            vm.importStatus = 'Falha ao importar repertório: ' + (error && error.message ? error.message : 'erro desconhecido');
            vm.importIssues = vm.importIssues.length ? vm.importIssues : ['Verifique o manifesto, os caminhos dos arquivos e o console do navegador.'];
            $scope.$applyAsync();
          });
      };

      vm.refreshLibrary();
      refreshMode();
      vm.ranking = core.rankProfiles(vm.profiles).slice(0, 5);
      vm.selectSong(vm.currentSong);
      vm.refreshScore();

      $scope.$on('$destroy', function () {
        stopTimer();
        vm.importedAudioUrls.forEach(function (url) {
          try {
            window.URL.revokeObjectURL(url);
          } catch (error) {}
        });
      });
    },
  ]);
})();
