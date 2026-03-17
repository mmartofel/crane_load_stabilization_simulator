// ============================================================
// results-ui.js — PID Optimizer UI: form, charts, table, modal
// ============================================================

import { Pendulum } from './sim.js';
import { TestScenario, computeScore, BatchOptimizer, computePhysicsRanges } from './optimizer.js';

// ---- State ----
let allResults = [];
let filteredResults = [];
let sortCol = 'score';
let sortAsc = true;
let optimizer = new BatchOptimizer();
let running = false;
let startTime = null;

// ---- DOM Refs (populated in init) ----
let elProgress, elProgressInner, elProgressLabel, elProgressEta;
let elTestCount, elRunBtn, elStopBtn, elZnBtn;
let elTableBody;
let elBestList;
let tooltipEl;
let chartTooltipEl;

// ---- Chart canvases ----
let cvHeatmap, cvTime, cvScatter, cvBar;

// ---- Shared palette (rank-indexed, used in time response + best sidebar) ----
const PALETTE = ['#00d4aa', '#f0a830', '#e05555', '#7b9fe0', '#a0d470'];

// ---- Shared tooltip formatter ----
function fmtTooltip(r) {
  const s = r.scenario, m = r.metrics;
  return `Kp=${s.Kp.toFixed(2)}  Ki=${s.Ki.toFixed(3)}  Kd=${s.Kd.toFixed(2)}\n` +
         `Score=${m.score?.toFixed(4)}  Ts=${m.t_settle != null ? m.t_settle.toFixed(1)+'s' : '—'}  OS=${m.overshoot_deg?.toFixed(1)}°`;
}

function showChartTooltip(e, text) {
  if (!chartTooltipEl) return;
  chartTooltipEl.textContent = text;
  chartTooltipEl.style.display = 'block';
  chartTooltipEl.style.left = (e.clientX + 14) + 'px';
  chartTooltipEl.style.top  = (e.clientY - 12) + 'px';
}

function hideChartTooltip() {
  if (chartTooltipEl) chartTooltipEl.style.display = 'none';
}

// ============================================================
// Tab switching
// ============================================================
function initTabs() {
  const tabSim = document.getElementById('tab-sim');
  const tabPid = document.getElementById('tab-pid');
  const appDiv = document.getElementById('app');
  const pidDiv = document.getElementById('pid-tester');

  if (!tabSim || !tabPid) return;

  tabSim.addEventListener('click', () => {
    appDiv.style.display = '';
    pidDiv.style.display = 'none';
    tabSim.classList.add('active');
    tabPid.classList.remove('active');
  });

  tabPid.addEventListener('click', () => {
    appDiv.style.display = 'none';
    pidDiv.style.display = 'flex';
    tabSim.classList.remove('active');
    tabPid.classList.add('active');
    // Resize charts after display change
    setTimeout(redrawAll, 50);
  });
}

// ============================================================
// Apply to simulator
// ============================================================
function applyToSimulator(Kp, Ki, Kd) {
  const L = getPidL(), m = getPidM();

  // Sync simulator scenario (rope length + mass)
  const slRope = document.getElementById('sl-rope');
  const slMass = document.getElementById('sl-mass');
  if (slRope) { slRope.value = L; slRope.dispatchEvent(new Event('input')); }
  if (slMass) { slMass.value = m; slMass.dispatchEvent(new Event('input')); }

  // Trigger bounds update in simulator
  window.dispatchEvent(new CustomEvent('pid-bounds-update', { detail: { L, m } }));

  // Set PID gains — expand slider max if Z-N value exceeds physics bounds
  [['kp', Kp], ['ki', Ki], ['kd', Kd]].forEach(([k, val]) => {
    const slider = document.getElementById(`sl-${k}`);
    if (!slider) return;
    if (val > parseFloat(slider.max)) slider.max = val.toFixed(3);
    slider.value = val;
    slider.dispatchEvent(new Event('input'));
  });
  document.getElementById('tab-sim')?.click();
}

// ============================================================
// Range helpers
// ============================================================
function linspace(start, end, n) {
  if (n <= 1) return [start];
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(start + (end - start) * i / (n - 1));
  return arr;
}

function getRange(prefix) {
  const min = parseFloat(document.getElementById(`${prefix}-min`)?.value ?? 0);
  const max = parseFloat(document.getElementById(`${prefix}-max`)?.value ?? 1);
  const steps = parseInt(document.getElementById(`${prefix}-steps`)?.value ?? 3);
  return linspace(min, max, Math.max(1, Math.min(steps, 10)));
}

function getPidL()    { return parseFloat(document.getElementById('pid-L').value); }
function getPidM()    { return parseFloat(document.getElementById('pid-m').value); }
function getPidDist() { return document.getElementById('pid-dist').value; }

function updateTestCount() {
  const kpR = getRange('kp');
  const kiR = getRange('ki');
  const kdR = getRange('kd');
  const total = kpR.length * kiR.length * kdR.length;
  if (elTestCount) elTestCount.textContent = `${total} tests`;
  return total;
}

function setRangeInputs(prefix, range) {
  const el = (id) => document.getElementById(`${prefix}-${id}`);
  if (el('min'))  el('min').value  = range.min;
  if (el('max'))  el('max').value  = range.max;
  // leave 'steps' unchanged (user controls grid resolution)
}

function onScenarioChange() {
  const L = getPidL(), m = getPidM();
  const r = computePhysicsRanges(L, m);

  setRangeInputs('kp', r.Kp);
  setRangeInputs('kd', r.Kd);
  setRangeInputs('ki', r.Ki);

  document.getElementById('pi-T').textContent      = r.T;
  document.getElementById('pi-Kpcrit').textContent = r.Kp_crit;
  document.getElementById('pi-Kdmax').textContent  = r.Kd.max;

  updateTestCount();
}

// ============================================================
// Run tests
// ============================================================
async function runTests() {
  const kpR = getRange('kp');
  const kiR = getRange('ki');
  const kdR = getRange('kd');
  const windSpeed = parseFloat(document.getElementById('pid-wind-speed')?.value ?? 8);

  running = true;
  startTime = Date.now();
  allResults = [];
  setRunningUI(true);
  setProgress(0, 0, '...');

  const batchResults = [];

  optimizer = new BatchOptimizer();
  await optimizer.runGridSearch({
    Kp_range: kpR,
    Ki_range: kiR,
    Kd_range: kdR,
    L_values: [getPidL()],
    m_values: [getPidM()],
    disturbance_types: [getPidDist()],
    wind_speed: windSpeed,
    onProgress: ({ done, total, result }) => {
      batchResults.push(result);
      const pct = done / total;
      const elapsed = (Date.now() - startTime) / 1000;
      const eta = done > 0 ? ((elapsed / done) * (total - done)).toFixed(0) : '?';
      setProgress(pct, done, `${done}/${total} — ETA: ${eta}s`);
    },
    onComplete: (results) => {
      allResults = results;
      filteredResults = [...allResults];
      running = false;
      setRunningUI(false);
      setProgress(1, allResults.length, 'Completed');
      renderTable(filteredResults);
      redrawAll();
      updateBestSidebar();
      saveResultsToServer(allResults);
    }
  });
}

function stopTests() {
  optimizer.cancel();
  running = false;
  setRunningUI(false);
}

async function runZN() {
  const windSpeed = parseFloat(document.getElementById('pid-wind-speed')?.value ?? 8);

  elZnBtn.disabled = true;
  elZnBtn.textContent = 'Computing...';

  try {
    const opt = new BatchOptimizer();
    const { Kp, Ki, Kd, Ku, Tu } = await opt.runZieglerNichols({
      L: getPidL(), m: getPidM(), wind_speed: windSpeed
    });

    const box = document.getElementById('zn-result');
    if (box) {
      box.style.display = 'block';
      box.innerHTML = `Ku=${Ku.toFixed(2)} Tu=${Tu.toFixed(2)}s<br>Kp=${Kp.toFixed(3)} Ki=${Ki.toFixed(3)} Kd=${Kd.toFixed(3)}`;
    }
    applyToSimulator(Kp, Ki, Kd);
  } catch(e) {
    console.error('Z-N error:', e);
  }

  elZnBtn.disabled = false;
  elZnBtn.textContent = 'Auto Ziegler-Nichols';
}

function setRunningUI(isRunning) {
  if (elRunBtn) elRunBtn.disabled = isRunning;
  if (elStopBtn) elStopBtn.disabled = !isRunning;
  if (elZnBtn) elZnBtn.disabled = isRunning;
}

function setProgress(pct, done, label) {
  if (elProgressInner) elProgressInner.style.width = `${Math.round(pct * 100)}%`;
  if (elProgressLabel) elProgressLabel.textContent = label;
}

// ============================================================
// Save to server
// ============================================================
async function saveResultsToServer(results) {
  try {
    const resp = await fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results })
    });
    const data = await resp.json();
    console.log('Saved:', data);
  } catch(e) {
    console.warn('Could not save to server:', e);
  }
}

async function loadResultsFromServer() {
  try {
    const resp = await fetch('/api/results?top=500&sort=score');
    const data = await resp.json();
    if (data.results && data.results.length) {
      // Convert server flat rows back to result objects
      allResults = data.results.map(r => ({
        scenario: {
          L: parseFloat(r.L), m: parseFloat(r.m),
          Kp: parseFloat(r.Kp), Ki: parseFloat(r.Ki), Kd: parseFloat(r.Kd),
          wind_speed: parseFloat(r.wind_speed),
          wind_dir: parseFloat(r.wind_dir_deg) * Math.PI / 180,
          disturbance_type: r.disturbance_type
        },
        timestamp: r.timestamp,
        metrics: {
          ISE: parseFloat(r.ISE), IAE: parseFloat(r.IAE), ITAE: parseFloat(r.ITAE),
          t_settle: r.t_settle === 'null' ? null : parseFloat(r.t_settle),
          overshoot_deg: parseFloat(r.overshoot_deg),
          steady_state_error: parseFloat(r.steady_state_error),
          score: parseFloat(r.score)
        },
        time_series: [],
        status: r.status
      }));
      filteredResults = [...allResults];
      renderTable(filteredResults);
      redrawAll();
      updateBestSidebar();
    }
  } catch(e) {
    console.warn('Could not load from server:', e);
  }
}

async function clearResults() {
  if (!confirm('Delete all results?')) return;
  allResults = [];
  filteredResults = [];
  renderTable([]);
  redrawAll();
  updateBestSidebar();
  try { await fetch('/api/results', { method: 'DELETE' }); } catch(e) {}
}

// ============================================================
// Table
// ============================================================
const TABLE_COLS = [
  { key: 'score',              label: 'Score',      fmt: v => v?.toFixed(4) },
  { key: 'Kp',                 label: 'Kp',         fmt: v => v?.toFixed(2), src: 'scenario' },
  { key: 'Ki',                 label: 'Ki',         fmt: v => v?.toFixed(3), src: 'scenario' },
  { key: 'Kd',                 label: 'Kd',         fmt: v => v?.toFixed(2), src: 'scenario' },
  { key: 'L',                  label: 'L',          fmt: v => v?.toFixed(1), src: 'scenario' },
  { key: 'm',                  label: 'm',          fmt: v => v?.toFixed(0), src: 'scenario' },
  { key: 'disturbance_type',   label: 'Disturbance', fmt: v => v,             src: 'scenario' },
  { key: 't_settle',           label: 'Ts [s]',     fmt: v => v != null ? v.toFixed(2) : '—' },
  { key: 'overshoot_deg',      label: 'OS [°]',     fmt: v => v?.toFixed(2) },
  { key: 'steady_state_error', label: 'SSE [°]',    fmt: v => v?.toFixed(3) },
  { key: 'ISE',                label: 'ISE',        fmt: v => v?.toFixed(2) },
  { key: 'status',             label: 'Status',     fmt: v => v,             isStatus: true },
];

function renderTable(results) {
  const wrap = document.getElementById('pid-table-body');
  if (!wrap) return;

  if (!results.length) {
    wrap.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#2a3441;padding:20px">No results</td></tr>';
    return;
  }

  const sorted = [...results].sort((a, b) => {
    const av = getCol(a, sortCol);
    const bv = getCol(b, sortCol);
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  wrap.innerHTML = sorted.slice(0, 200).map((r, i) => {
    const cells = TABLE_COLS.map(col => {
      const raw = col.src === 'scenario' ? r.scenario?.[col.key] : r.metrics?.[col.key] ?? r[col.key];
      const val = raw !== undefined ? raw : (r.metrics?.[col.key]);
      const display = col.fmt(val ?? (col.isStatus ? r.status : null));
      if (col.isStatus) {
        const cls = `status-${r.status}`;
        return `<td><span class="status-badge ${cls}">${display}</span></td>`;
      }
      return `<td>${display ?? '—'}</td>`;
    }).join('');
    return `<tr data-idx="${i}" style="cursor:pointer">${cells}</tr>`;
  }).join('');

  // Row click → modal
  wrap.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => showModal(sorted[i]));
  });
}

function getCol(r, key) {
  if (key in r) return r[key];
  if (r.metrics && key in r.metrics) return r.metrics[key];
  if (r.scenario && key in r.scenario) return r.scenario[key];
  return null;
}

function attachSort() {
  document.querySelectorAll('#pid-results-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = true; }
      document.querySelectorAll('#pid-results-table th').forEach(t => t.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-arrow').textContent = sortAsc ? '▲' : '▼';
      renderTable(filteredResults);
    });
  });
}

function filterTable() {
  const q = document.getElementById('pid-table-filter')?.value?.toLowerCase() ?? '';
  if (!q) { filteredResults = [...allResults]; }
  else {
    filteredResults = allResults.filter(r => {
      const s = r.scenario;
      return `${s.Kp} ${s.Ki} ${s.Kd} ${s.L} ${s.m} ${s.disturbance_type} ${r.status}`.toLowerCase().includes(q);
    });
  }
  renderTable(filteredResults);
  redrawAll();
}

// ============================================================
// Modal
// ============================================================
function showModal(result) {
  const backdrop = document.getElementById('pid-modal-backdrop');
  if (!backdrop) return;

  const s = result.scenario;
  const m = result.metrics;

  document.getElementById('modal-kp').textContent = s.Kp?.toFixed(3) ?? '—';
  document.getElementById('modal-ki').textContent = s.Ki?.toFixed(4) ?? '—';
  document.getElementById('modal-kd').textContent = s.Kd?.toFixed(3) ?? '—';
  document.getElementById('modal-L').textContent = s.L?.toFixed(1) ?? '—';
  document.getElementById('modal-m').textContent = s.m ?? '—';
  document.getElementById('modal-dist').textContent = s.disturbance_type ?? '—';
  document.getElementById('modal-score').textContent = m.score?.toFixed(4) ?? '—';
  document.getElementById('modal-tsettle').textContent = m.t_settle != null ? m.t_settle.toFixed(2) + 's' : '—';
  document.getElementById('modal-overshoot').textContent = m.overshoot_deg?.toFixed(2) + '°' ?? '—';
  document.getElementById('modal-sse').textContent = m.steady_state_error?.toFixed(3) + '°' ?? '—';
  document.getElementById('modal-status').textContent = result.status;
  document.getElementById('modal-status').className = `status-badge status-${result.status}`;

  // Mini theta(t) chart
  const cv = document.getElementById('modal-canvas');
  if (cv && result.time_series?.length) drawMiniTheta(cv, result.time_series);

  // Apply button
  const applyBtn = document.getElementById('modal-apply-btn');
  if (applyBtn) {
    applyBtn.onclick = () => {
      applyToSimulator(s.Kp, s.Ki, s.Kd);
      closeModal();
    };
  }

  backdrop.style.display = 'flex';
}

function closeModal() {
  const backdrop = document.getElementById('pid-modal-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function drawMiniTheta(canvas, ts) {
  const W = canvas.offsetWidth || 580;
  const H = canvas.offsetHeight || 160;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  if (!ts.length) return;
  const maxT = ts[ts.length - 1].t;
  const maxTheta = Math.max(...ts.map(p => p.theta_mag), 1);

  const pad = 20;
  const toX = t => pad + (t / maxT) * (W - 2*pad);
  const toY = v => H - pad - (v / maxTheta) * (H - 2*pad);

  // Grid lines
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (i / 4) * (H - 2*pad);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }

  // theta_mag line
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(toX(p.t), toY(p.theta_mag));
    else ctx.lineTo(toX(p.t), toY(p.theta_mag));
  });
  ctx.stroke();

  // 1° threshold line
  ctx.strokeStyle = '#604020';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  const y1deg = toY(1);
  ctx.beginPath(); ctx.moveTo(pad, y1deg); ctx.lineTo(W - pad, y1deg); ctx.stroke();
  ctx.setLineDash([]);

  // Axis labels
  ctx.fillStyle = '#4a6080';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillText(`${maxTheta.toFixed(1)}°`, 2, pad + 3);
  ctx.fillText('0°', 2, H - pad + 3);
  ctx.fillText(`${maxT.toFixed(0)}s`, W - 24, H - 4);
}

// ============================================================
// Charts
// ============================================================
function redrawAll() {
  if (cvHeatmap) drawHeatmap(cvHeatmap, filteredResults);
  if (cvTime) drawTimeResponse(cvTime, filteredResults);
  if (cvScatter) drawScatter(cvScatter, filteredResults);
  if (cvBar) drawBarChart(cvBar, filteredResults);
}

function sizeCanvas(canvas) {
  const W = canvas.parentElement?.clientWidth || 300;
  const H = canvas.parentElement?.clientHeight || 200;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
}

// ---- Heatmap: Kp (x) vs Kd (y), color = score ----
function drawHeatmap(canvas, results) {
  sizeCanvas(canvas);
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  if (!results.length) {
    drawEmpty(ctx, W, H, 'No data — run tests');
    return;
  }

  const pad = 32;
  const KpVals = [...new Set(results.map(r => r.scenario.Kp))].sort((a,b)=>a-b);
  const KdVals = [...new Set(results.map(r => r.scenario.Kd))].sort((a,b)=>a-b);
  if (!KpVals.length || !KdVals.length) return;

  const cellW = (W - 2*pad) / KpVals.length;
  const cellH = (H - 2*pad) / KdVals.length;

  // Build score map (average if multiple Ki)
  const scoreMap = {};
  results.forEach(r => {
    const key = `${r.scenario.Kp}_${r.scenario.Kd}`;
    if (!scoreMap[key]) scoreMap[key] = [];
    scoreMap[key].push(r.metrics.score || 1);
  });

  KpVals.forEach((Kp, xi) => {
    KdVals.forEach((Kd, yi) => {
      const key = `${Kp}_${Kd}`;
      const scores = scoreMap[key];
      if (!scores) return;
      const avgScore = scores.reduce((a,b)=>a+b,0) / scores.length;
      // score 0=best (green) 1=worst (red), map to hue 120→0
      const hue = Math.round((1 - Math.min(avgScore, 1)) * 120);
      ctx.fillStyle = `hsl(${hue}, 80%, 35%)`;
      const x = pad + xi * cellW;
      const y = pad + (KdVals.length - 1 - yi) * cellH;
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
    });
  });

  // Axis labels
  ctx.fillStyle = '#4a6080';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  KpVals.forEach((v, i) => {
    if (KpVals.length <= 8 || i % 2 === 0) {
      ctx.fillText(v.toFixed(1), pad + i * cellW + cellW/2, H - 2);
    }
  });
  ctx.textAlign = 'right';
  KdVals.forEach((v, i) => {
    const y = pad + (KdVals.length - 1 - i) * cellH + cellH/2 + 3;
    ctx.fillText(v.toFixed(1), pad - 2, y);
  });
  ctx.textAlign = 'center';
  ctx.fillText('Kp →', W / 2, H - 2);
  ctx.save();
  ctx.translate(10, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Kd →', 0, 0);
  ctx.restore();
}

// ---- Time response: top 5 results theta_mag vs t ----
function drawTimeResponse(canvas, results, hoverIdx = -1) {
  sizeCanvas(canvas);
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const top5 = [...results]
    .filter(r => r.time_series?.length > 2 && r.status !== 'diverged')
    .sort((a,b) => a.metrics.score - b.metrics.score)
    .slice(0, 5);

  if (!top5.length) {
    drawEmpty(ctx, W, H, 'No time response data');
    canvas._chartData = null;
    return;
  }

  const pad = 28;
  const allPts = top5.flatMap(r => r.time_series);
  const maxT = Math.max(...allPts.map(p => p.t), 1);
  const maxTheta = Math.max(...allPts.map(p => p.theta_mag), 1);

  const toX = t => pad + (t / maxT) * (W - 2*pad);
  const toY = v => H - pad - (v / maxTheta) * (H - 2*pad);

  // Grid
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + i * (H - 2*pad) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W-pad, y); ctx.stroke();
  }

  top5.forEach((r, ri) => {
    const isHover = ri === hoverIdx;
    ctx.strokeStyle = PALETTE[ri % PALETTE.length];
    ctx.lineWidth = isHover ? 3 : 1.5;
    ctx.globalAlpha = (hoverIdx >= 0 && !isHover) ? 0.35 : 1;
    ctx.beginPath();
    r.time_series.forEach((p, i) => {
      if (i === 0) ctx.moveTo(toX(p.t), toY(p.theta_mag));
      else ctx.lineTo(toX(p.t), toY(p.theta_mag));
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // 1° line
  ctx.strokeStyle = '#604020';
  ctx.lineWidth = 1;
  ctx.setLineDash([4,4]);
  const y1 = toY(1);
  ctx.beginPath(); ctx.moveTo(pad, y1); ctx.lineTo(W-pad, y1); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#4a6080';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${maxTheta.toFixed(1)}°`, pad + 2, pad + 10);
  ctx.fillText(`${maxT.toFixed(0)}s`, W - pad - 2, H - 4);

  // In-canvas legend (bottom-left)
  const legendX = pad + 4, legendStartY = H - pad - 4 - (top5.length * 13);
  ctx.font = '9px JetBrains Mono, monospace';
  top5.forEach((r, ri) => {
    const s = r.scenario;
    const ly = legendStartY + ri * 13;
    ctx.fillStyle = PALETTE[ri % PALETTE.length];
    ctx.fillRect(legendX, ly - 7, 8, 8);
    ctx.fillStyle = ri === hoverIdx ? '#c8d4e0' : '#4a6080';
    ctx.textAlign = 'left';
    ctx.fillText(`#${ri+1} Kp=${s.Kp.toFixed(1)} Ki=${s.Ki.toFixed(2)} Kd=${s.Kd.toFixed(1)}`, legendX + 12, ly);
  });

  // Store metadata for hit testing
  canvas._chartData = top5;
  canvas._meta = { pad, maxT, maxTheta, W, H };
}

// ---- Scatter: t_settle (x) vs overshoot (y), color = score ----
function drawScatter(canvas, results) {
  sizeCanvas(canvas);
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const valid = results.filter(r => r.metrics.t_settle != null && r.status !== 'diverged');
  if (!valid.length) {
    drawEmpty(ctx, W, H, 'No stable results');
    return;
  }

  const pad = 28;
  const maxTs = Math.max(...valid.map(r => r.metrics.t_settle), 1);
  const maxOs = Math.max(...valid.map(r => r.metrics.overshoot_deg), 1);

  const toX = v => pad + (v / maxTs) * (W - 2*pad);
  const toY = v => H - pad - (v / maxOs) * (H - 2*pad);

  // "Good zone" rectangle (settle < 10s, overshoot < 5°)
  const gx = pad, gw = Math.min(toX(10) - pad, W - 2*pad);
  const gy = toY(5), gh = H - pad - gy;
  if (gw > 0 && gh > 0) {
    ctx.fillStyle = 'rgba(0,84,54,0.15)';
    ctx.fillRect(gx, gy, gw, gh);
    ctx.strokeStyle = '#004433';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.strokeRect(gx, gy, gw, gh);
    ctx.setLineDash([]);
  }

  valid.forEach(r => {
    const score = r.metrics.score;
    const hue = Math.round((1 - Math.min(score, 1)) * 120);
    ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
    const x = toX(r.metrics.t_settle);
    const y = toY(r.metrics.overshoot_deg);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#4a6080';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Ts [s] →', W / 2, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText(`OS[°]`, pad - 2, pad + 8);

  // Store for hit testing
  canvas._chartData = valid;
  canvas._meta = { pad, maxTs, maxOs, W, H };
}

// ---- Bar chart: top 10 score (horizontal bars) ----
function drawBarChart(canvas, results) {
  sizeCanvas(canvas);
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const top10 = [...results]
    .filter(r => r.status !== 'diverged')
    .sort((a,b) => a.metrics.score - b.metrics.score)
    .slice(0, 10);

  if (!top10.length) {
    drawEmpty(ctx, W, H, 'No data');
    return;
  }

  const padL = 120, padR = 40, padT = 10, padB = 10;
  const barH = Math.floor((H - padT - padB) / top10.length) - 2;
  const maxScore = Math.max(...top10.map(r => r.metrics.score), 0.01);

  const grad = ctx.createLinearGradient(padL, 0, W - padR, 0);
  grad.addColorStop(0, '#00d4aa');
  grad.addColorStop(1, '#006644');

  top10.forEach((r, i) => {
    const s = r.scenario;
    const y = padT + i * (barH + 2);
    const barW = (r.metrics.score / maxScore) * (W - padL - padR);

    ctx.fillStyle = grad;
    ctx.fillRect(padL, y, barW, barH);

    ctx.fillStyle = '#4a6080';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`Kp${s.Kp?.toFixed(1)} Ki${s.Ki?.toFixed(2)} Kd${s.Kd?.toFixed(1)}`, padL - 3, y + barH - 2);

    ctx.fillStyle = '#8b9ab0';
    ctx.textAlign = 'left';
    ctx.fillText(r.metrics.score?.toFixed(3), padL + barW + 3, y + barH - 2);
  });

  // Store for hit testing
  canvas._chartData = top10;
  canvas._meta = { padL, padT, barH, W, H };
}

function drawEmpty(ctx, W, H, msg) {
  ctx.fillStyle = '#2a3441';
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(msg, W/2, H/2);
}

// ============================================================
// Best params sidebar
// ============================================================
function updateBestSidebar() {
  const container = document.getElementById('best-list');
  if (!container) return;

  const best = [...allResults]
    .filter(r => r.status !== 'diverged')
    .sort((a,b) => a.metrics.score - b.metrics.score)
    .slice(0, 5);

  if (!best.length) {
    container.innerHTML = '<div class="pid-empty-state">No results</div>';
    return;
  }

  container.innerHTML = best.map((r, i) => {
    const s = r.scenario;
    const dot = `<span class="best-color-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>`;
    return `<div class="best-entry">
      <div class="best-entry-rank">${dot}#${i+1} — Score: ${r.metrics.score.toFixed(4)}</div>
      <div class="best-entry-params">Kp=${s.Kp?.toFixed(2)}<br>Ki=${s.Ki?.toFixed(3)}<br>Kd=${s.Kd?.toFixed(2)}</div>
      <div class="best-entry-score">L=${s.L} m=${s.m} ${s.disturbance_type}</div>
      <button class="best-apply-btn" data-kp="${s.Kp}" data-ki="${s.Ki}" data-kd="${s.Kd}">Apply</button>
    </div>`;
  }).join('');

  container.querySelectorAll('.best-apply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyToSimulator(parseFloat(btn.dataset.kp), parseFloat(btn.dataset.ki), parseFloat(btn.dataset.kd));
    });
  });
}

// ============================================================
// Time response tooltip + click
// ============================================================
function initTimeTooltip() {
  if (!cvTime) return;
  let lastHoverIdx = -1;

  cvTime.addEventListener('mousemove', (e) => {
    const data = cvTime._chartData;
    const meta = cvTime._meta;
    if (!data || !meta) { hideChartTooltip(); return; }

    const rect = cvTime.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { pad, maxT, maxTheta, W, H } = meta;

    // Map mouse X → time index in each series
    let bestIdx = -1, bestDist = 20;
    data.forEach((r, ri) => {
      const ts = r.time_series;
      if (!ts.length) return;
      const t = ((mx - pad) / (W - 2*pad)) * maxT;
      // Binary-search for closest time point
      let lo = 0, hi = ts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid].t < t) lo = mid + 1; else hi = mid;
      }
      const pt = ts[Math.min(lo, ts.length - 1)];
      const py = H - pad - (pt.theta_mag / maxTheta) * (H - 2*pad);
      const dist = Math.abs(my - py);
      if (dist < bestDist) { bestDist = dist; bestIdx = ri; }
    });

    if (bestIdx >= 0) {
      if (bestIdx !== lastHoverIdx) {
        lastHoverIdx = bestIdx;
        drawTimeResponse(cvTime, filteredResults, bestIdx);
      }
      cvTime.style.cursor = 'pointer';
      showChartTooltip(e, `#${bestIdx+1} | ` + fmtTooltip(data[bestIdx]));
    } else {
      if (lastHoverIdx !== -1) {
        lastHoverIdx = -1;
        drawTimeResponse(cvTime, filteredResults, -1);
      }
      cvTime.style.cursor = 'default';
      hideChartTooltip();
    }
  });

  cvTime.addEventListener('mouseleave', () => {
    hideChartTooltip();
    if (lastHoverIdx !== -1) {
      lastHoverIdx = -1;
      drawTimeResponse(cvTime, filteredResults, -1);
    }
    cvTime.style.cursor = 'default';
  });

  cvTime.addEventListener('click', (e) => {
    const data = cvTime._chartData;
    const meta = cvTime._meta;
    if (!data || !meta) return;

    const rect = cvTime.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { pad, maxT, maxTheta, W, H } = meta;

    let bestIdx = -1, bestDist = 20;
    data.forEach((r, ri) => {
      const ts = r.time_series;
      if (!ts.length) return;
      const t = ((mx - pad) / (W - 2*pad)) * maxT;
      let lo = 0, hi = ts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid].t < t) lo = mid + 1; else hi = mid;
      }
      const pt = ts[Math.min(lo, ts.length - 1)];
      const py = H - pad - (pt.theta_mag / maxTheta) * (H - 2*pad);
      const dist = Math.abs(my - py);
      if (dist < bestDist) { bestDist = dist; bestIdx = ri; }
    });

    if (bestIdx >= 0) {
      const s = data[bestIdx].scenario;
      applyToSimulator(s.Kp, s.Ki, s.Kd);
    }
  });
}

// ============================================================
// Scatter tooltip + click
// ============================================================
function initScatterTooltip() {
  if (!cvScatter) return;

  cvScatter.addEventListener('mousemove', (e) => {
    const data = cvScatter._chartData;
    const meta = cvScatter._meta;
    if (!data || !meta) { hideChartTooltip(); return; }

    const rect = cvScatter.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { pad, maxTs, maxOs, W, H } = meta;

    let best = null, bestDist2 = 10 * 10;
    data.forEach(r => {
      const px = pad + (r.metrics.t_settle / maxTs) * (W - 2*pad);
      const py = H - pad - (r.metrics.overshoot_deg / maxOs) * (H - 2*pad);
      const d2 = (mx - px) ** 2 + (my - py) ** 2;
      if (d2 < bestDist2) { bestDist2 = d2; best = r; }
    });

    if (best) {
      cvScatter.style.cursor = 'pointer';
      showChartTooltip(e, fmtTooltip(best));
    } else {
      cvScatter.style.cursor = 'default';
      hideChartTooltip();
    }
  });

  cvScatter.addEventListener('mouseleave', () => {
    hideChartTooltip();
    cvScatter.style.cursor = 'default';
  });

  cvScatter.addEventListener('click', (e) => {
    const data = cvScatter._chartData;
    const meta = cvScatter._meta;
    if (!data || !meta) return;

    const rect = cvScatter.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { pad, maxTs, maxOs, W, H } = meta;

    let best = null, bestDist2 = 10 * 10;
    data.forEach(r => {
      const px = pad + (r.metrics.t_settle / maxTs) * (W - 2*pad);
      const py = H - pad - (r.metrics.overshoot_deg / maxOs) * (H - 2*pad);
      const d2 = (mx - px) ** 2 + (my - py) ** 2;
      if (d2 < bestDist2) { bestDist2 = d2; best = r; }
    });

    if (best) {
      const s = best.scenario;
      applyToSimulator(s.Kp, s.Ki, s.Kd);
    }
  });
}

// ============================================================
// Bar chart tooltip + click
// ============================================================
function initBarTooltip() {
  if (!cvBar) return;

  function getRowIdx(my) {
    const meta = cvBar._meta;
    if (!meta) return -1;
    const { padT, barH } = meta;
    const i = Math.floor((my - padT) / (barH + 2));
    const data = cvBar._chartData;
    if (!data || i < 0 || i >= data.length) return -1;
    return i;
  }

  cvBar.addEventListener('mousemove', (e) => {
    const data = cvBar._chartData;
    if (!data) { hideChartTooltip(); return; }

    const rect = cvBar.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const i = getRowIdx(my);

    if (i >= 0) {
      cvBar.style.cursor = 'pointer';
      showChartTooltip(e, fmtTooltip(data[i]));
    } else {
      cvBar.style.cursor = 'default';
      hideChartTooltip();
    }
  });

  cvBar.addEventListener('mouseleave', () => {
    hideChartTooltip();
    cvBar.style.cursor = 'default';
  });

  cvBar.addEventListener('click', (e) => {
    const data = cvBar._chartData;
    if (!data) return;

    const rect = cvBar.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const i = getRowIdx(my);

    if (i >= 0) {
      const s = data[i].scenario;
      applyToSimulator(s.Kp, s.Ki, s.Kd);
    }
  });
}

// ============================================================
// Heatmap tooltip + click
// ============================================================
function heatmapHitTest(mx, my) {
  if (!filteredResults.length) return null;
  const W = cvHeatmap.width, H = cvHeatmap.height;
  const pad = 32;

  const KpVals = [...new Set(filteredResults.map(r => r.scenario.Kp))].sort((a,b)=>a-b);
  const KdVals = [...new Set(filteredResults.map(r => r.scenario.Kd))].sort((a,b)=>a-b);
  if (!KpVals.length || !KdVals.length) return null;

  const cellW = (W - 2*pad) / KpVals.length;
  const cellH = (H - 2*pad) / KdVals.length;
  const xi = Math.floor((mx - pad) / cellW);
  const yi = KdVals.length - 1 - Math.floor((my - pad) / cellH);

  if (xi < 0 || xi >= KpVals.length || yi < 0 || yi >= KdVals.length) return null;

  const Kp = KpVals[xi], Kd = KdVals[yi];
  // Pick the best (lowest score) result for this Kp/Kd cell
  const cellResults = filteredResults.filter(r => r.scenario.Kp === Kp && r.scenario.Kd === Kd);
  if (!cellResults.length) return null;
  const best = cellResults.reduce((a, b) => a.metrics.score <= b.metrics.score ? a : b);
  return best;
}

function initHeatmapTooltip() {
  if (!cvHeatmap) return;
  tooltipEl = document.getElementById('heatmap-tooltip');

  cvHeatmap.addEventListener('mousemove', (e) => {
    if (!tooltipEl) return;
    const rect = cvHeatmap.getBoundingClientRect();
    const best = heatmapHitTest(e.clientX - rect.left, e.clientY - rect.top);

    if (best) {
      const s = best.scenario;
      tooltipEl.style.display = 'block';
      tooltipEl.style.left = (e.clientX + 12) + 'px';
      tooltipEl.style.top  = (e.clientY - 10) + 'px';
      tooltipEl.textContent =
        `Kp=${s.Kp.toFixed(2)}  Ki=${s.Ki.toFixed(3)}  Kd=${s.Kd.toFixed(2)} | Score=${best.metrics.score?.toFixed(4)}`;
      cvHeatmap.style.cursor = 'pointer';
    } else {
      tooltipEl.style.display = 'none';
      cvHeatmap.style.cursor = 'default';
    }
  });

  cvHeatmap.addEventListener('mouseleave', () => {
    if (tooltipEl) tooltipEl.style.display = 'none';
    cvHeatmap.style.cursor = 'default';
  });

  cvHeatmap.addEventListener('click', (e) => {
    const rect = cvHeatmap.getBoundingClientRect();
    const best = heatmapHitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (best) {
      const s = best.scenario;
      applyToSimulator(s.Kp, s.Ki, s.Kd);
    }
  });
}

// ============================================================
// Window resize
// ============================================================
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawAll, 100);
});

// ============================================================
// Init
// ============================================================
function init() {
  initTabs();

  // Cache DOM refs
  elProgressInner = document.getElementById('progress-bar-inner');
  elProgressLabel = document.getElementById('progress-label');
  elTestCount     = document.getElementById('pid-test-count');
  elRunBtn        = document.getElementById('pid-run-btn');
  elStopBtn       = document.getElementById('pid-stop-btn');
  elZnBtn         = document.getElementById('pid-zn-btn');

  cvHeatmap = document.getElementById('chart-heatmap');
  cvTime    = document.getElementById('chart-time');
  cvScatter = document.getElementById('chart-scatter');
  cvBar     = document.getElementById('chart-bar');

  // Range input listeners for test count
  document.querySelectorAll('.pid-range-input').forEach(el => {
    el.addEventListener('input', updateTestCount);
  });

  // Scenario selects → auto-fill ranges + physics info
  document.getElementById('pid-L')?.addEventListener('change', onScenarioChange);
  document.getElementById('pid-m')?.addEventListener('change', onScenarioChange);
  document.getElementById('pid-dist')?.addEventListener('change', updateTestCount);

  // Initialize ranges based on default L/m selection
  onScenarioChange();

  // Buttons
  elRunBtn?.addEventListener('click', runTests);
  elStopBtn?.addEventListener('click', stopTests);
  elZnBtn?.addEventListener('click', runZN);

  document.getElementById('pid-export-btn')?.addEventListener('click', () => {
    window.open('/api/results/export', '_blank');
  });

  document.getElementById('pid-clear-btn')?.addEventListener('click', clearResults);

  // Table filter
  document.getElementById('pid-table-filter')?.addEventListener('input', filterTable);

  // Modal close
  document.getElementById('pid-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('pid-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  chartTooltipEl = document.getElementById('chart-tooltip');

  attachSort();
  initHeatmapTooltip();
  initTimeTooltip();
  initScatterTooltip();
  initBarTooltip();
  updateTestCount();

  // Load saved results from server
  loadResultsFromServer();

  // Initial empty renders
  redrawAll();
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
