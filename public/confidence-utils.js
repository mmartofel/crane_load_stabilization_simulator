// confidence-utils.js — shared helpers for ML model confidence display
// Exposed as window.* so they work across ES6 module and non-module scripts.

window.confidenceLabel = function(conf) {
  if (conf < 0.50) return 'FALLBACK';
  if (conf < 0.75) return 'LOW';
  if (conf < 0.90) return 'HIGH';
  return 'VERY HIGH';
};

// Returns a CSS color value appropriate for the confidence level
window.confidenceColor = function(conf) {
  if (conf < 0.50) return 'var(--red)';
  if (conf < 0.75) return 'var(--warn)';
  return 'var(--accent)';
};

// Returns a semi-transparent background appropriate for the confidence level
window.confidenceBgColor = function(conf) {
  if (conf < 0.50) return 'rgba(255,68,68,0.12)';
  if (conf < 0.75) return 'rgba(255,107,53,0.12)';
  return 'rgba(0,212,170,0.12)';
};
