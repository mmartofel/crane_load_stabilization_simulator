const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const CSV_PATH = path.join(__dirname, '..', 'data', 'test_results.csv');
const CSV_HEADER = 'timestamp,L,m,Kp,Ki,Kd,wind_speed,wind_dir_deg,disturbance_type,ISE,IAE,ITAE,t_settle,overshoot_deg,steady_state_error,score,status\n';

function ensureCSV() {
  const dir = path.dirname(CSV_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER);
}

function parseCSV() {
  ensureCSV();
  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).filter(l => l).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = vals[i]?.trim());
    return obj;
  });
}

// POST /api/results
router.post('/', (req, res) => {
  ensureCSV();
  const { results } = req.body;
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results must be array' });
  const rows = results.map(r => {
    const s = r.scenario, m = r.metrics;
    return [
      r.timestamp, s.L, s.m, s.Kp, s.Ki, s.Kd,
      s.wind_speed, (s.wind_dir * 180/Math.PI).toFixed(1), s.disturbance_type,
      m.ISE?.toFixed(4), m.IAE?.toFixed(4), m.ITAE?.toFixed(4),
      m.t_settle != null ? m.t_settle.toFixed(2) : 'null', m.overshoot_deg?.toFixed(2),
      m.steady_state_error?.toFixed(4), m.score?.toFixed(4), r.status
    ].join(',');
  });
  fs.appendFileSync(CSV_PATH, rows.join('\n') + '\n');
  const total = parseCSV().length;
  res.json({ saved: results.length, total_in_file: total });
});

// GET /api/results
router.get('/', (req, res) => {
  let rows = parseCSV();
  const { L, m, top = 50, sort = 'score' } = req.query;
  if (L) rows = rows.filter(r => r.L === L);
  if (m) rows = rows.filter(r => r.m === m);
  rows.sort((a, b) => parseFloat(a[sort] || 0) - parseFloat(b[sort] || 0));
  rows = rows.slice(0, parseInt(top));
  const best = {};
  rows.forEach(r => {
    const key = `L${r.L}_m${r.m}`;
    if (!best[key] || parseFloat(r.score) < parseFloat(best[key].score)) best[key] = r;
  });
  res.json({ results: rows, best_by_scenario: best });
});

// GET /api/results/export
router.get('/export', (req, res) => {
  ensureCSV();
  res.setHeader('Content-Disposition', 'attachment; filename="test_results.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.sendFile(CSV_PATH);
});

// DELETE /api/results
router.delete('/', (req, res) => {
  if (fs.existsSync(CSV_PATH)) fs.unlinkSync(CSV_PATH);
  res.json({ deleted: true });
});

module.exports = router;
