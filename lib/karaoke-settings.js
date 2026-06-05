(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KaraokeSettings = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  return {
    playback: Object.freeze({
      blockedStatus: 'Aguardando microfone pausado',
      readyStatus: 'Pronto para tocar',
      syncingStatus: 'Sincronizando voz',
      pausedStatus: 'Microfone pausado',
    }),
    scoring: Object.freeze({
      timingToleranceMs: 180,
      timingPenalty: -5,
      pitchToleranceCents: 35,
      pitchPenaltyAbove: -3,
      pitchPenaltyBelow: -3,
      dbTolerance: 4,
      dbPenalty: -2,
      perfectBonus: 3,
      latePenaltyBoost: -2,
    }),
    voice: Object.freeze({
      minConfidence: 0.72,
      transcriptMatchWeight: 1,
      browserHint: 'Chrome ou Edge',
    }),
  };
});
