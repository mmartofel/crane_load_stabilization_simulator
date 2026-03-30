// ============================================================
// reports-ui.js — REPORTS tab: session list, charts, tables
// ============================================================

// ── Shared chart constants ────────────────────────────────────
const CHART_LEFT_MARGIN  = 52;   // pixels reserved for Y-axis labels
const CHART_RIGHT_MARGIN = 16;
const SCENARIO_DURATION  = 360;  // seconds
const Y_ZERO_FRAC        = 0.85; // zero line at 85% from top
const Y_MAX_FRAC         = 0.05; // max value at 5% from top

// ── Module-level hover cursor state ──────────────────────────
let hoverTimeS     = null;
let _activeSession = null;  // session currently displayed

// ── Confidence pill renderer for decision table ───────────────
function renderConfCell(conf) {
  if (conf == null) return '<td class="conf-cell">—</td>';
  const color   = window.confidenceColor   ? window.confidenceColor(conf)   : '#00d4aa';
  const bgColor = window.confidenceBgColor ? window.confidenceBgColor(conf) : 'rgba(0,212,170,0.12)';
  const label   = window.confidenceLabel   ? window.confidenceLabel(conf)   : '';
  const pct     = Math.round(conf * 100);
  return `
    <td class="conf-cell">
      <div class="conf-pill" style="background:${bgColor};color:${color}">
        <div class="conf-pill-bar" style="width:${pct}%;background:${color}"></div>
        <span class="conf-pill-text">${conf.toFixed(2)} ${label}</span>
      </div>
    </td>`;
}

// ── Shared X-axis mapping (both charts use identical scale) ───
function timeToX(timeS, canvasWidth) {
  const usableWidth = canvasWidth - CHART_LEFT_MARGIN - CHART_RIGHT_MARGIN;
  return CHART_LEFT_MARGIN + (timeS / SCENARIO_DURATION) * usableWidth;
}

// Redraw both charts (called from hover events)
function redrawCharts() {
  if (!_activeSession) return;
  reportsUI.renderThetaChart(_activeSession);
  reportsUI.renderParamsChart(_activeSession);
}

// ── Interpolate |θ| at a given time from timeseries ──────────
function interpolateTheta(timeS, timeSeries) {
  if (!timeSeries || timeSeries.length === 0) return 0;
  const toTheta = p => p.theta != null
    ? p.theta
    : Math.hypot(p.theta_x || 0, p.theta_y || 0) * 180 / Math.PI;
  const before = [...timeSeries].filter(p => p.t <= timeS).pop();
  const after  = timeSeries.find(p => p.t > timeS);
  if (!before) return toTheta(timeSeries[0]);
  if (!after)  return toTheta(before);
  const frac = (timeS - before.t) / (after.t - before.t);
  return toTheta(before) + (toTheta(after) - toTheta(before)) * frac;
}

// ── Extract phase parameter summary from scenario events ─────
function getPhaseParamsLabel(phase) {
  const scenario = window.AI_SCENARIO;
  if (!scenario) return '';
  // Build running state from events up to time t
  function stateAt(t) {
    let state = { L: 12, m: 50, wind_speed: 8 };
    scenario.events.forEach(ev => {
      if (ev.t <= t && (ev.type === 'set' || ev.type === 'ramp')) {
        Object.assign(state, ev.params);
      }
    });
    return state;
  }
  const s = stateAt(phase.t_start);
  const e = stateAt(Math.max(phase.t_start, phase.t_end - 1));
  const Lstr = Math.abs((s.L || 12) - (e.L || 12)) > 0.5
    ? `${Math.round(s.L || 12)}→${Math.round(e.L || 12)}m`
    : `${Math.round(s.L || 12)}m`;
  const mstr = Math.abs((s.m || 50) - (e.m || 50)) > 1
    ? `${Math.round(s.m || 50)}→${Math.round(e.m || 50)}kg`
    : `${Math.round(s.m || 50)}kg`;
  const ws = s.wind_speed || 8;
  const we = e.wind_speed || 8;
  const wstr = Math.abs(ws - we) > 0.5
    ? `${Math.round(ws)}→${Math.round(we)}m/s`
    : `${Math.round(ws)}m/s`;
  return `L:${Lstr}  m:${mstr}  wind:${wstr}`;
}

// ── Draw a phase label flag box at top of chart canvas ────────
function drawPhaseFlag(ctx, xCenter, phaseColor, line1, line2) {
  const padX = 8, padY = 4;
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  const w1 = ctx.measureText(line1).width;
  ctx.font = '9px JetBrains Mono, monospace';
  const w2 = line2 ? ctx.measureText(line2).width : 0;
  const boxW = Math.max(w1, w2) + padX * 2;
  const boxH = (line2 ? 30 : 16) + padY * 2;
  const boxX = xCenter - boxW / 2;
  const boxY = 6;

  ctx.fillStyle = phaseColor + 'cc';
  ctx.beginPath();
  try { ctx.roundRect(boxX, boxY, boxW, boxH, 4); }
  catch { ctx.rect(boxX, boxY, boxW, boxH); }
  ctx.fill();
  ctx.strokeStyle = phaseColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 10px JetBrains Mono, monospace';
  ctx.fillText(line1, xCenter, boxY + padY + 10);
  if (line2) {
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillText(line2, xCenter, boxY + padY + 23);
  }
  ctx.textAlign = 'left';
}

// ── Draw phase backgrounds and vertical separators ────────────
function drawPhaseBackgrounds(ctx, phases, canvasWidth, canvasHeight, drawFlags) {
  if (!phases) return;
  phases.forEach(phase => {
    const x1    = timeToX(phase.t_start, canvasWidth);
    const x2    = timeToX(phase.t_end,   canvasWidth);
    const color = phase.color || '#888888';

    // Subtle tinted background
    ctx.fillStyle = color + '12';
    ctx.fillRect(x1, 0, x2 - x1, canvasHeight);

    // Vertical separator at phase start (skip first phase)
    if (phase.t_start > 0) {
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, canvasHeight);
      ctx.strokeStyle = color + '80';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Phase flag (theta chart only)
    if (drawFlags) {
      const xCenter = (x1 + x2) / 2;
      drawPhaseFlag(ctx, xCenter, color, phase.label, getPhaseParamsLabel(phase));
    }
  });
}

// ── Compute per-phase metrics from session data ───────────────
function computePhaseMetrics(session) {
  // Use pre-computed phases object if it has sufficient data
  if (session.phases && typeof session.phases === 'object') {
    const vals = Object.values(session.phases).filter(Boolean);
    if (vals.length >= 3) return vals;
  }

  // Fallback: compute from timeseries + scenario definition
  const phases = window.AI_SCENARIO?.phases || [
    { t_start: 0,   t_end: 108, label: 'Cycle 1 — load 50 kg',   color: '#1D9E75' },
    { t_start: 108, t_end: 180, label: 'Empty run',               color: '#5F5E5A' },
    { t_start: 180, t_end: 330, label: 'Cycle 2 — load 150 kg',   color: '#378ADD' },
    { t_start: 330, t_end: 360, label: 'Finish',                   color: '#5F5E5A' },
  ];

  const ts = session.timeseries || session.time_series || [];
  const toTheta  = p => p.theta != null
    ? p.theta
    : Math.hypot(p.theta_x || 0, p.theta_y || 0) * 180 / Math.PI;
  const toThetaX = p => p.theta_x_deg != null
    ? Math.abs(p.theta_x_deg)
    : Math.abs((p.theta_x || 0) * 180 / Math.PI);
  const toThetaY = p => p.theta_y_deg != null
    ? Math.abs(p.theta_y_deg)
    : Math.abs((p.theta_y || 0) * 180 / Math.PI);

  return phases.map(phase => {
    const slice = ts.filter(p => p.t >= phase.t_start && p.t < phase.t_end);
    if (slice.length === 0) {
      return { ...phase, avg_theta: null, max_theta: null, max_theta_x: null, max_theta_y: null,
               pct_within_5: null, decisions: 0, noData: true };
    }
    const thetas    = slice.map(toTheta);
    const thetasX   = slice.map(toThetaX);
    const thetasY   = slice.map(toThetaY);
    const within5   = slice.filter(p => toThetaX(p) < 5 && toThetaY(p) < 5).length;
    const decisions = (session.ai_decisions || [])
      .filter(d => d.t >= phase.t_start && d.t < phase.t_end).length;
    return {
      ...phase,
      avg_theta:   thetas.reduce((a, b) => a + b, 0) / thetas.length,
      max_theta:   Math.max(...thetas),
      max_theta_x: Math.max(...thetasX),
      max_theta_y: Math.max(...thetasY),
      pct_within_5: +(within5 / slice.length * 100).toFixed(1),
      decisions,
      noData: false
    };
  });
}

// ============================================================
// ReportsUI class
// ============================================================

class ReportsUI {
  constructor() {
    this.sessions              = [];
    this.activeSessionId       = null;
    this.selectedForComparison = new Set();
    this._resizeObserver       = null;
  }

  async loadSessions() {
    try {
      const resp   = await fetch('/api/sessions');
      this.sessions = await resp.json();
    } catch {
      this.sessions = [];
    }
    this.renderSessionList();
    if (this.sessions.length > 0) {
      this.showSession(this.sessions[0].session_id);
    } else {
      this._showEmpty();
    }
  }

  renderSessionList() {
    const el = document.getElementById('reports-session-list');
    if (!el) return;
    if (this.sessions.length === 0) {
      el.innerHTML = '<div class="rep-empty">No sessions yet.<br>Run an AI DRIVEN scenario to generate reports.</div>';
      return;
    }
    el.innerHTML = this.sessions.map(s => {
      const date = new Date(s.timestamp).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const avg      = s.metrics?.avg_theta_deg?.toFixed(2) ?? '—';
      const max      = s.metrics?.max_theta_deg?.toFixed(2) ?? '—';
      const upd      = s.metrics?.ai_updates ?? '—';
      const isActive   = s.session_id === this.activeSessionId;
      const isSelected = this.selectedForComparison.has(s.session_id);
      return `<div class="rep-session-card ${isActive ? 'active' : ''}" data-id="${s.session_id}">
        <div class="rep-session-header">
          <input type="checkbox" class="rep-compare-check" data-id="${s.session_id}" ${isSelected ? 'checked' : ''}>
          <span class="rep-session-date">${date}</span>
        </div>
        <div class="rep-session-meta">Avg θ: ${avg}°  Max θ: ${max}°  Updates: ${upd}</div>
        <button class="rep-btn-view btn btn-primary" data-id="${s.session_id}">View report</button>
      </div>`;
    }).join('');

    el.querySelectorAll('.rep-btn-view').forEach(btn => {
      btn.addEventListener('click', () => this.showSession(btn.dataset.id));
    });
    el.querySelectorAll('.rep-compare-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        if (e.target.checked) this.selectedForComparison.add(e.target.dataset.id);
        else this.selectedForComparison.delete(e.target.dataset.id);
        this._updateCompareBtn();
      });
    });
  }

  _updateCompareBtn() {
    const btn = document.getElementById('rep-btn-compare');
    if (!btn) return;
    btn.disabled  = this.selectedForComparison.size < 2;
    btn.textContent = `Compare selected (${this.selectedForComparison.size})`;
    this._updateDeleteBtn();
  }

  _updateDeleteBtn() {
    const btn = document.getElementById('rep-btn-delete');
    if (!btn) return;
    btn.disabled  = this.selectedForComparison.size === 0;
    btn.textContent = `Delete selected (${this.selectedForComparison.size})`;
  }

  async deleteSelected() {
    if (this.selectedForComparison.size === 0) return;
    const ids = [...this.selectedForComparison];
    if (!confirm(`Delete ${ids.length} session(s)? This cannot be undone.`)) return;
    await Promise.all(ids.map(id =>
      fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
    ));
    const activeWasDeleted = ids.includes(this.activeSessionId);
    this.sessions = this.sessions.filter(s => !this.selectedForComparison.has(s.session_id));
    this.selectedForComparison.clear();
    if (activeWasDeleted) this.activeSessionId = null;
    this.renderSessionList();
    this._updateCompareBtn();
    if (activeWasDeleted) {
      if (this.sessions.length > 0) this.showSession(this.sessions[0].session_id);
      else this._showEmpty();
    }
  }

  showSession(sessionId) {
    const session = this.sessions.find(s => s.session_id === sessionId);
    if (!session) return;
    this.activeSessionId = sessionId;
    _activeSession = session;
    this.renderSessionList();

    // Show detail, hide comparison and empty state
    const detail   = document.getElementById('reports-detail');
    const compare  = document.getElementById('reports-compare');
    const emptyEl  = document.getElementById('rep-empty-state');
    const summary  = document.getElementById('reports-summary');
    const bodyMain = document.getElementById('reports-body-main');
    if (detail)   detail.style.display   = '';
    if (compare)  compare.style.display  = 'none';
    if (emptyEl)  emptyEl.style.display  = 'none';
    if (summary)  summary.style.display  = '';
    if (bodyMain) bodyMain.style.display = '';

    const titleEl = document.getElementById('rep-session-title');
    if (titleEl) titleEl.textContent = `Session: ${new Date(session.timestamp).toLocaleString('en-GB')}`;

    this.renderSummaryCards(session);
    this.renderPhaseTable(session);
    this.renderDecisionTable(session);
    this.renderModelInfo(session);

    // Defer canvas renders until layout is fully computed
    requestAnimationFrame(() => {
      this._resizeCanvases();
      this.renderThetaChart(session);
      this.renderParamsChart(session);
    });

    // Bind export buttons
    const csvBtn  = document.getElementById('rep-export-csv');
    const jsonBtn = document.getElementById('rep-export-json');
    if (csvBtn)  csvBtn.onclick  = () => this.exportCSV(session);
    if (jsonBtn) jsonBtn.onclick = () => this.exportJSON(session);

    this._setupResizeObserver();
  }

  _resizeCanvases() {
    const thetaCanvas  = document.getElementById('rep-theta-chart');
    const paramsCanvas = document.getElementById('rep-params-chart');
    if (thetaCanvas) {
      thetaCanvas.width  = thetaCanvas.parentElement?.clientWidth || 600;
      thetaCanvas.height = 300;
    }
    if (paramsCanvas) {
      paramsCanvas.width  = paramsCanvas.parentElement?.clientWidth || 600;
      paramsCanvas.height = 220;
    }
  }

  _setupResizeObserver() {
    if (this._resizeObserver) return;
    const container = document.getElementById('reports-left');
    if (!container) return;
    this._resizeObserver = new ResizeObserver(() => {
      if (!_activeSession) return;
      this._resizeCanvases();
      redrawCharts();
    });
    this._resizeObserver.observe(container);
  }

  renderSummaryCards(session) {
    const m   = session.metrics || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('rep-card-avg',     (m.avg_theta_deg ?? '—') + '°');
    set('rep-card-max',     (m.max_theta_deg ?? '—') + '°');
    set('rep-card-updates', m.ai_updates ?? '—');
    set('rep-card-forced',  m.forced_updates ?? '—');

    // Per-axis quality gate card (within 5° on both axes)
    const gateEl = document.getElementById('rep-card-gate');
    if (gateEl) {
      if (m.pct_within_5deg != null) {
        const pct  = m.pct_within_5deg;
        const pass = pct >= 95;
        gateEl.textContent = pct + '%';
        gateEl.style.color = pass ? '#2ecc71' : (pct >= 70 ? '#f39c12' : '#e74c3c');
      } else {
        gateEl.textContent = '—';
        gateEl.style.color = '';
      }
    }

    // AVG CONF card
    const decisions = session.ai_decisions || [];
    const withConf  = decisions.filter(d => d.confidence != null);
    const confEl    = document.getElementById('rep-card-conf');
    if (confEl) {
      if (withConf.length > 0) {
        const avg   = withConf.reduce((s, d) => s + d.confidence, 0) / withConf.length;
        const color = window.confidenceColor ? window.confidenceColor(avg) : '#00d4aa';
        const label = window.confidenceLabel ? window.confidenceLabel(avg) : '';
        confEl.textContent = avg.toFixed(2);
        confEl.style.color = color;
        const labelEl = confEl.parentElement?.querySelector('.rep-card-label');
        if (labelEl) labelEl.textContent = `Model Confidence (${label})`;
      } else {
        confEl.textContent = '—';
        confEl.style.color = '';
      }
    }
  }

  renderThetaChart(session) {
    const canvas = document.getElementById('rep-theta-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  || 600;
    const H   = canvas.height || 300;
    const ts  = session.timeseries || session.time_series || [];
    const toTheta = p => p.theta != null
      ? p.theta
      : Math.hypot(p.theta_x || 0, p.theta_y || 0) * 180 / Math.PI;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    if (ts.length < 2) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No time series data', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    const maxDeg = Math.max(5, ...ts.map(toTheta)) * 1.1;

    // Map theta → Y pixel (zero at Y_ZERO_FRAC, max at Y_MAX_FRAC)
    const thetaToY = theta => {
      const frac = Math.min(theta / maxDeg, 1);
      return H * (Y_ZERO_FRAC - frac * (Y_ZERO_FRAC - Y_MAX_FRAC));
    };

    // Phase backgrounds, separators, flags
    drawPhaseBackgrounds(ctx, window.AI_SCENARIO?.phases, W, H, true);

    // Horizontal grid lines every 5°
    const gridStep   = 5;
    const maxGridDeg = Math.ceil(maxDeg / gridStep) * gridStep;
    for (let deg = 0; deg <= maxGridDeg; deg += gridStep) {
      const y = thetaToY(deg);
      if (y < 0 || y > H) continue;
      ctx.beginPath();
      const is15 = deg === 15;
      ctx.strokeStyle = is15 ? 'rgba(255,68,68,0.45)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth   = is15 ? 1 : 0.5;
      ctx.setLineDash(is15 ? [5, 5] : []);
      ctx.moveTo(CHART_LEFT_MARGIN, y);
      ctx.lineTo(W - CHART_RIGHT_MARGIN, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle  = is15 ? 'rgba(255,120,120,0.7)' : 'rgba(255,255,255,0.4)';
      ctx.font       = '10px JetBrains Mono, monospace';
      ctx.textAlign  = 'right';
      ctx.fillText(`${deg}°`, CHART_LEFT_MARGIN - 4, y + 3);
    }
    ctx.textAlign = 'left';

    // θ(t) curve
    ctx.beginPath();
    ts.forEach((p, i) => {
      const x = timeToX(p.t, W);
      const y = thetaToY(toTheta(p));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Forced decision markers
    (session.ai_decisions || []).filter(d => d.forced).forEach(d => {
      const x = timeToX(d.t, W);
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.strokeStyle = 'rgba(255,157,0,0.45)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle  = '#ff9d00';
      ctx.font       = '11px monospace';
      ctx.textAlign  = 'center';
      ctx.fillText('⚡', x, 56);
    });
    ctx.textAlign = 'left';

    // Hover cursor
    if (hoverTimeS !== null) {
      const x = timeToX(hoverTimeS, W);
      ctx.beginPath();
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      const thetaVal = interpolateTheta(hoverTimeS, ts);
      const y        = thetaToY(thetaVal);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD600';
      ctx.fill();
    }

    // X-axis time labels
    ctx.fillStyle = '#8b949e';
    ctx.font      = '9px monospace';
    [0, 60, 120, 180, 240, 300, 360].forEach(sec => {
      const x = timeToX(sec, W);
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.floor(sec / 60)}:00`, x, H - 4);
    });

    // Legend top-right
    const lgX = W - CHART_RIGHT_MARGIN - 4;
    ctx.fillStyle = '#00d4aa';
    ctx.fillRect(lgX - 88, H - 18, 14, 3);
    ctx.fillStyle = '#8b949e';
    ctx.font      = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('AI controlled |θ|', lgX, H - 14);
    ctx.textAlign = 'left';
  }

  renderParamsChart(session) {
    const canvas = document.getElementById('rep-params-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width  || 600;
    const H   = canvas.height || 220;
    const ts  = session.timeseries || session.time_series || [];

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    if (ts.length < 2) return;

    const PAD_T = 16, PAD_B = 24;
    const iH    = H - PAD_T - PAD_B;

    // Independent Y scales per series
    const KP_MAX = Math.max(...ts.map(p => p.Kp || 0), 1)   * 1.1;
    const KI_MAX = Math.max(...ts.map(p => p.Ki || 0), 0.01) * 1.1;
    const KD_MAX = Math.max(...ts.map(p => p.Kd || 0), 0.5)  * 1.1;

    const series = [
      { key: 'Kp', color: '#F0997B', max: KP_MAX },
      { key: 'Ki', color: '#EF9F27', max: KI_MAX },
      { key: 'Kd', color: '#5DCAA5', max: KD_MAX },
    ];

    // Map value → Y with its own scale (zero at bottom, max at PAD_T)
    const valToY = (val, maxVal) =>
      H - PAD_B - Math.min(val / maxVal, 1) * iH;

    // Phase backgrounds and separators (no flags)
    drawPhaseBackgrounds(ctx, window.AI_SCENARIO?.phases, W, H, false);

    // Faint grid lines per series (25%, 50%, 75%, 100%)
    series.forEach(s => {
      [0.25, 0.5, 0.75, 1.0].forEach(frac => {
        const y = valToY(s.max * frac, s.max);
        if (y < PAD_T || y > H - PAD_B) return;
        ctx.beginPath();
        ctx.strokeStyle = s.color + '25';
        ctx.lineWidth   = 0.5;
        ctx.moveTo(CHART_LEFT_MARGIN, y);
        ctx.lineTo(W - CHART_RIGHT_MARGIN, y);
        ctx.stroke();
      });
    });

    // Y-axis value labels (50% and max for each series, stacked in margin)
    [0.5, 1.0].forEach(frac => {
      series.forEach((s, si) => {
        const val = s.max * frac;
        const y   = valToY(val, s.max);
        if (y < PAD_T || y > H - PAD_B) return;
        ctx.fillStyle  = s.color + 'bb';
        ctx.font       = '8px monospace';
        ctx.textAlign  = 'right';
        ctx.fillText(val >= 1 ? val.toFixed(1) : val.toFixed(2),
          CHART_LEFT_MARGIN - 2, y + 3);
      });
    });
    ctx.textAlign = 'left';

    // PID series curves
    series.forEach(s => {
      ctx.beginPath();
      ts.forEach((p, i) => {
        const x = timeToX(p.t, W);
        const y = valToY(p[s.key] || 0, s.max);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });

    // Forced update markers
    (session.ai_decisions || []).filter(d => d.forced).forEach(d => {
      const x = timeToX(d.t, W);
      ctx.beginPath();
      ctx.moveTo(x, PAD_T); ctx.lineTo(x, H - PAD_B);
      ctx.strokeStyle = 'rgba(255,157,0,0.35)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Hover cursor
    if (hoverTimeS !== null) {
      const x = timeToX(hoverTimeS, W);
      ctx.beginPath();
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      // Colored circles on each series at cursor time
      series.forEach(s => {
        const before = [...ts].filter(p => p.t <= hoverTimeS).pop();
        const after  = ts.find(p => p.t > hoverTimeS);
        let val = 0;
        if (before && after) {
          const frac = (hoverTimeS - before.t) / (after.t - before.t);
          val = (before[s.key] || 0) + ((after[s.key] || 0) - (before[s.key] || 0)) * frac;
        } else if (before) {
          val = before[s.key] || 0;
        }
        const y = valToY(val, s.max);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle   = s.color;
        ctx.fill();
        ctx.strokeStyle = '#FFD600';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      });
    }

    // Legend — top-right corner, vertical stack
    const lastP = ts[ts.length - 1] || {};
    const lgX   = W - CHART_RIGHT_MARGIN;
    series.forEach((s, i) => {
      const val    = lastP[s.key];
      const valStr = val != null ? (val >= 1 ? val.toFixed(2) : val.toFixed(3)) : '—';
      const lgY    = PAD_T + i * 16;
      ctx.fillStyle = s.color;
      ctx.fillRect(lgX - 80, lgY - 3, 12, 3);
      ctx.font      = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${s.key}  ${valStr}`, lgX, lgY);
    });
    ctx.textAlign = 'left';

    // X-axis time labels
    ctx.fillStyle = '#8b949e';
    ctx.font      = '9px monospace';
    [0, 60, 120, 180, 240, 300, 360].forEach(sec => {
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.floor(sec / 60)}m`, timeToX(sec, W), H - 4);
    });
    ctx.textAlign = 'left';
  }

  renderPhaseTable(session) {
    const el = document.getElementById('rep-phase-table-body');
    if (!el) return;
    const phases = computePhaseMetrics(session);
    if (!phases || phases.length === 0) {
      el.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">No phase data</td></tr>';
      return;
    }

    // Quality gate badge: green if avg_theta < 5° on both axes, red otherwise
    const gateBadge = phase => {
      if (phase.avg_theta == null) return '<span style="color:var(--text-dim)">—</span>';
      const pass = phase.avg_theta < 5.0
        && (phase.max_theta_x == null || phase.max_theta_x < 5.0)
        && (phase.max_theta_y == null || phase.max_theta_y < 5.0);
      return pass
        ? '<span style="color:#2ecc71;font-weight:700" title="Both axes within 5°">✓ OK</span>'
        : '<span style="color:#e74c3c;font-weight:700" title="Exceeded 5° on at least one axis">✗ OVER</span>';
    };

    el.innerHTML = phases.map(phase => {
      if (!phase || phase.noData) {
        return `<tr style="opacity:0.45">
          <td><span style="color:${phase?.color || '#888'}">■</span> ${phase?.label || '—'}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>`;
      }
      const axInfo = phase.max_theta_x != null
        ? `${phase.max_theta_x.toFixed(1)}° / ${phase.max_theta_y.toFixed(1)}°`
        : '—';
      const pct = phase.pct_within_5 != null ? phase.pct_within_5 + '%' : '—';
      return `<tr>
        <td><span style="color:${phase.color || '#888'}">■</span> ${phase.label}</td>
        <td>${gateBadge(phase)}</td>
        <td>${phase.avg_theta != null ? phase.avg_theta.toFixed(2) + '°' : '—'}</td>
        <td>${phase.max_theta != null ? phase.max_theta.toFixed(2) + '°' : '—'}
            <small style="color:var(--text-dim);margin-left:4px">${axInfo}</small></td>
        <td>${pct}</td>
        <td>${phase.decisions ?? '—'}</td>
      </tr>`;
    }).join('');
  }

  renderDecisionTable(session) {
    const el      = document.getElementById('rep-decision-table-body');
    const countEl = document.getElementById('rep-decision-count');
    if (!el) return;
    const decisions = session.ai_decisions || [];
    if (countEl) countEl.textContent = `(${decisions.length})`;

    if (decisions.length === 0) {
      el.innerHTML = '<tr><td colspan="6" style="color:var(--text-dim)">No decisions recorded</td></tr>';
      return;
    }

    el.innerHTML = '';
    decisions.forEach(d => {
      const tr = document.createElement('tr');
      if (d.forced) tr.classList.add('rep-forced-row');

      const icon = d.forced ? '⚡' : d.fallback ? '⚠' : '→';

      // Format gain delta: prev→new with ↑/↓ arrow and color
      const fmtGain = (val, prev, digits) => {
        if (val == null) return '—';
        const v = val.toFixed(digits);
        if (prev == null) return v;
        const delta = val - prev;
        if (Math.abs(delta) < 0.001) return v;
        const arrow = delta > 0 ? ' ↑' : ' ↓';
        const color = delta > 0 ? '#4dcc88' : '#ff6666';
        return `<span style="color:${color}">${prev.toFixed(digits)}→${v}${arrow}</span>`;
      };

      tr.innerHTML = `
        <td>${icon} ${this._fmt(d.t)}</td>
        <td>${fmtGain(d.Kp, d.prevKp, 2)}</td>
        <td>${fmtGain(d.Ki, d.prevKi, 3)}</td>
        <td>${fmtGain(d.Kd, d.prevKd, 2)}</td>
        ${renderConfCell(d.confidence)}
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(d.reason || '').replace(/_/g, ' ')}</td>
      `;

      tr.addEventListener('mouseenter', () => {
        hoverTimeS       = d.t;
        tr.style.background = 'rgba(255,214,0,0.08)';
        redrawCharts();
      });
      tr.addEventListener('mouseleave', () => {
        hoverTimeS       = null;
        tr.style.background = '';
        redrawCharts();
      });

      el.appendChild(tr);
    });
  }

  async renderModelInfo(session) {
    const container = document.getElementById('model-info-container');
    const content   = document.getElementById('model-info-content');
    if (!container || !content) return;
    container.style.display = '';

    // If the stabilizer was explicitly OFF for the whole session, no model was used
    if (session.stabilizer_on === false) {
      content.innerHTML = `
        <div class="model-result-panel">
          <div style="color:var(--warn);font-size:12px;padding:8px 0">
            ⊘ Stabilizer was OFF during this session — no AI model was used.
          </div>
        </div>`;
      return;
    }

    // Old sessions (before this fix) won't have model_info — show a notice
    if (!session.model_info) {
      content.innerHTML = `
        <div class="model-result-panel">
          <div style="color:#8b949e;font-size:11px;padding:8px 0">
            ℹ Model info was not recorded for this session.
          </div>
        </div>`;
      return;
    }

    // Use the model snapshot stored at the time this session was run
    const statsData = session.model_info;
    const stats   = statsData.stats || {};
    const metrics = stats.metrics   || {};
    const dr      = stats.data_range || {};
    const at      = stats.trained_at ? new Date(stats.trained_at).toLocaleString('en-GB') : '—';
    const modelId = statsData.model_id || 'GradientBoosting';

    // Count low-confidence decisions in this session
    const decisions = session.ai_decisions || [];
    const lowConfDecisions = decisions.filter(d => d.confidence != null && d.confidence < 0.75);
    const lowConfNote = lowConfDecisions.length > 0
      ? `<div style="font-size:10px;color:var(--warn);margin-top:4px">
           ⚠ Low confidence: ${lowConfDecisions.length} decision(s) (${Math.round(lowConfDecisions.length / Math.max(decisions.length,1) * 100)}%)
         </div>`
      : '';

    const rows = ['Kp', 'Ki', 'Kd'].map(p => {
      const r2  = metrics[p]?.r2  ?? null;
      const mae = metrics[p]?.mae ?? null;
      const pct   = r2 != null ? Math.round(r2 * 100) : 0;
      const color = window.confidenceColor ? window.confidenceColor(r2 ?? 0) : '#00d4aa';
      const lbl   = window.confidenceLabel ? window.confidenceLabel(r2 ?? 0) : '—';
      return `
        <div class="model-param-row">
          <span class="param-name">${p}</span>
          <div class="r2-bar-track"><div class="r2-bar-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="r2-value" style="color:${color}">R²=${r2 != null ? r2.toFixed(2) : '—'}</span>
          <span class="r2-label" style="color:${color}">${lbl}</span>
          <span class="mae-value">MAE=${mae != null ? mae.toFixed(3) : '—'}</span>
        </div>`;
    }).join('');

    content.innerHTML = `
      <div class="model-result-panel">
        <div class="model-result-header">
          <span>Model: ${modelId} &nbsp;|&nbsp; Trained: ${at}</span>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b949e;margin-bottom:6px">
          ${stats.n_total ?? '—'} training rows
        </div>
        <div class="model-result-title">Model Confidence (R² on test set)</div>
        ${rows}
        <div class="model-range-info">Training data range:
          L: ${dr.L_min ?? '?'}–${dr.L_max ?? '?'} m &nbsp;|&nbsp;
          m: ${dr.m_min ?? '?'}–${dr.m_max ?? '?'} kg &nbsp;|&nbsp;
          wind: 0–${dr.wind_max ?? '?'} m/s
        </div>
        ${lowConfNote}
      </div>`;
  }

  exportCSV(session) {
    const decisions = session.ai_decisions || [];
    const lines = [
      ['time_s', 'Kp', 'Ki', 'Kd', 'prevKp', 'prevKi', 'prevKd',
       'reason', 'forced', 'confidence'].join(','),
      ...decisions.map(d => [
        d.t, d.Kp, d.Ki, d.Kd, d.prevKp || '', d.prevKi || '', d.prevKd || '',
        d.reason || '', d.forced ? 1 : 0, d.confidence || 0
      ].join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ai_session_${session.session_id}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  exportJSON(session) {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `ai_session_${session.session_id}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  showComparison() {
    const selected = this.sessions.filter(s => this.selectedForComparison.has(s.session_id));
    if (selected.length < 2) return;
    const detail  = document.getElementById('reports-detail');
    const compare = document.getElementById('reports-compare');
    if (detail)  detail.style.display  = 'none';
    if (compare) compare.style.display = '';
    this._renderCompareChart(selected);
    this._renderCompareTable(selected);
  }

  _renderCompareChart(sessions) {
    const canvas = document.getElementById('rep-compare-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W   = canvas.width = canvas.offsetWidth || 500;
    const H   = canvas.height = 180;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const colors = ['#00d4aa', '#f0a830', '#e05555', '#7b9fe0'];
    const pad    = { l: 36, r: 12, t: 24, b: 24 };
    const iW     = W - pad.l - pad.r;
    const iH     = H - pad.t - pad.b;
    const barW   = Math.min(80, iW / sessions.length - 12);
    const maxAvg = Math.max(...sessions.map(s => s.metrics?.avg_theta_deg || 0), 0.1) * 1.15;

    [0, 0.5, 1].forEach(frac => {
      const y = pad.t + iH * (1 - frac);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle  = '#8b949e';
      ctx.font       = '8px monospace';
      ctx.textAlign  = 'right';
      ctx.fillText(`${(maxAvg * frac).toFixed(1)}°`, pad.l - 3, y + 3);
    });

    sessions.forEach((s, i) => {
      const avg = s.metrics?.avg_theta_deg || 0;
      const bH  = (avg / maxAvg) * iH;
      const bx  = pad.l + i * (iW / sessions.length) + (iW / sessions.length - barW) / 2;
      const by  = pad.t + iH - bH;
      ctx.fillStyle = colors[i % colors.length] + 'aa';
      ctx.fillRect(bx, by, barW, bH);
      ctx.fillStyle  = colors[i % colors.length];
      ctx.font       = '10px monospace';
      ctx.textAlign  = 'center';
      ctx.fillText(`${avg.toFixed(2)}°`, bx + barW / 2, by - 4);
      ctx.fillStyle  = '#8b949e';
      ctx.font       = '9px monospace';
      ctx.fillText(new Date(s.timestamp).toLocaleDateString('en-GB'), bx + barW / 2, H - 6);
    });
    ctx.textAlign = 'left';
  }

  _renderCompareTable(sessions) {
    const el = document.getElementById('rep-compare-table-body');
    if (!el) return;
    const cols   = ['avg_theta_deg', 'max_theta_deg', 'ai_updates', 'forced_updates'];
    const labels = ['Avg θ [°]', 'Max θ [°]', 'AI updates', 'Forced'];
    el.innerHTML = labels.map((label, ci) => {
      const vals = sessions.map(s => {
        const v = s.metrics?.[cols[ci]];
        return v != null ? (+v).toFixed(ci < 2 ? 2 : 0) : '—';
      });
      return `<tr><td class="rep-compare-label">${label}</td>${vals.map(v => `<td>${v}</td>`).join('')}</tr>`;
    }).join('');
    const head = document.getElementById('rep-compare-table-head');
    if (head) {
      head.innerHTML = `<tr><th>Metric</th>${sessions.map(s =>
        `<th>${new Date(s.timestamp).toLocaleDateString('en-GB')}</th>`).join('')}</tr>`;
    }
  }

  _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _showEmpty() {
    const summary  = document.getElementById('reports-summary');
    const bodyMain = document.getElementById('reports-body-main');
    if (summary)  summary.style.display  = 'none';
    if (bodyMain) bodyMain.style.display = 'none';

    const detail = document.getElementById('reports-detail');
    let emptyEl  = document.getElementById('rep-empty-state');
    if (!emptyEl && detail) {
      emptyEl    = document.createElement('div');
      emptyEl.id = 'rep-empty-state';
      emptyEl.className = 'rep-empty-detail';
      emptyEl.innerHTML = `
        <div style="font-size:32px;margin-bottom:16px">📋</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px">No sessions yet</div>
        <div style="color:var(--text-dim)">Run an AI DRIVEN scenario to generate reports.</div>
      `;
      detail.appendChild(emptyEl);
    }
    if (emptyEl) emptyEl.style.display = '';
  }
}

// ============================================================
// Module init
// ============================================================

const reportsUI = new ReportsUI();

window.addEventListener('reports-tab-activated', () => {
  reportsUI.loadSessions();
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rep-btn-compare')?.addEventListener('click', () => {
    reportsUI.showComparison();
    const backBtn = document.getElementById('rep-btn-back');
    if (backBtn) backBtn.style.display = '';
  });
  document.getElementById('rep-btn-delete')?.addEventListener('click', () => {
    reportsUI.deleteSelected();
  });
  document.getElementById('rep-btn-back')?.addEventListener('click', () => {
    if (reportsUI.activeSessionId) reportsUI.showSession(reportsUI.activeSessionId);
    else reportsUI._showEmpty();
    const backBtn = document.getElementById('rep-btn-back');
    if (backBtn) backBtn.style.display = 'none';
  });
  document.getElementById('rep-btn-back-compare')?.addEventListener('click', () => {
    if (reportsUI.activeSessionId) reportsUI.showSession(reportsUI.activeSessionId);
    else reportsUI._showEmpty();
  });
});
