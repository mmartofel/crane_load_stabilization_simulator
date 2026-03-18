// ============================================================
// ai-ui.js — AI DRIVEN tab: AIController, 3D scene, animation loop
// ============================================================

import { Pendulum, PIDController, PropellerMixer } from './sim.js';
import { CraneRenderer } from './renderer.js';

// ============================================================
// AIController — manages scenario, AI predictions, PID updates
// ============================================================

class AIController {
  constructor() {
    this.params      = { Kp: 8, Ki: 0.1, Kd: 2.5 };
    this.prevParams  = { ...this.params };
    this.updateEvery = 5.0;    // seconds between AI updates
    this.lastUpdate  = -999;
    this.useOllama   = false;
    this.history     = [];     // [{t, Kp, Ki, Kd, reason, forced, confidence}]
    this.timeseries  = [];     // [{t, theta, Kp, Ki, Kd}] recorded every ~1s

    this.conditions  = { L: 12, m: 50, wind_speed: 4, wind_dir: 60 };
    this.scenarioTime = 0;
    this.isRunning   = false;
    this.firedEvents = new Set();

    this._smoothIv   = null;   // interval for smooth PID transition
    this._lastTsRecord = 0;    // last time a timeseries point was recorded

    // Metrics
    this.metrics = { sumTheta: 0, maxTheta: 0, frames: 0,
                     perPhase: {} };

    // Physics instances
    this.pendulum = new Pendulum({ L: this.conditions.L, m: this.conditions.m });
    this.pidX     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.pidY     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.mixer    = new PropellerMixer();

    // Reference to 3D renderer (set via init)
    this.renderer = null;
  }

  reset() {
    this.params      = { Kp: 8, Ki: 0.1, Kd: 2.5 };
    this.prevParams  = { ...this.params };
    this.history     = [];
    this.timeseries  = [];
    this.conditions  = { L: 12, m: 50, wind_speed: 4, wind_dir: 60 };
    this.scenarioTime = 0;
    this.isRunning   = false;
    this.firedEvents = new Set();
    this.lastUpdate  = -999;
    this._lastTsRecord = 0;
    this.metrics     = { sumTheta: 0, maxTheta: 0, frames: 0, perPhase: {} };

    this.pendulum = new Pendulum({ L: this.conditions.L, m: this.conditions.m });
    this.pidX     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.pidY     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.mixer    = new PropellerMixer();

    if (this._smoothIv) { clearInterval(this._smoothIv); this._smoothIv = null; }

    if (this.renderer) this.renderer.resetTrail();
    updateDecisionHistoryUI([]);
    updateMetricsUI({ sumTheta: 0, maxTheta: 0, frames: 0 });
    updateOllamaPanel('—');
  }

  // Fetch prediction from AI service (with analytical fallback)
  async requestPrediction(L, m, wind_speed, wind_dir_deg) {
    try {
      const resp = await fetch('/api/ai/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          L, m, wind_speed, wind_dir_deg,
          theta_x: this.pendulum.state.theta_x,
          theta_y: this.pendulum.state.theta_y,
          use_ollama_explanation: this.useOllama
        }),
        signal: AbortSignal.timeout(3000)
      });
      return await resp.json();
    } catch {
      // Local analytical fallback
      const g = 9.81, T = 2 * Math.PI / Math.sqrt(g / Math.max(L, 0.1));
      return {
        Kp: Math.min((m * g / Math.max(L, 0.1)) * 0.55, 18),
        Ki: 0.1 / Math.max(L / 10, 0.1),
        Kd: T * 0.4,
        confidence: 0, model: 'fallback', fallback: true, explanation: null
      };
    }
  }

  async forceUpdate(reason) {
    const c = this.conditions;
    const result = await this.requestPrediction(c.L, c.m, c.wind_speed, c.wind_dir);
    this.applyParams(result, reason, true);
    this.lastUpdate = this.scenarioTime;
    // Update model status display
    if (result.model && result.model !== 'fallback') {
      updateModelStatus(result.model, result.confidence);
    }
  }

  applyParams(result, reason = '', forced = false) {
    this.prevParams = { ...this.params };
    this.params = {
      Kp: Math.max(0, result.Kp || 0),
      Ki: Math.max(0, result.Ki || 0),
      Kd: Math.max(0, result.Kd || 0)
    };
    this._smoothTransition(this.prevParams, this.params, 2000);
    this.history.push({
      t:           this.scenarioTime,
      Kp:          this.params.Kp,
      Ki:          this.params.Ki,
      Kd:          this.params.Kd,
      prevKp:      this.prevParams.Kp,
      prevKi:      this.prevParams.Ki,
      prevKd:      this.prevParams.Kd,
      reason, forced,
      confidence:  result.confidence,
      fallback:    result.fallback || false,
      explanation: result.explanation || null
    });
    if (this.history.length > 50) this.history.shift();
    updateDecisionHistoryUI(this.history);
    updateCurrentParamsUI(this.params, this.prevParams);
    if (result.explanation) updateOllamaPanel(result.explanation);
    updateModelStatus(result.model || 'fallback', result.confidence || 0);
  }

  _smoothTransition(from, to, durationMs) {
    if (this._smoothIv) clearInterval(this._smoothIv);
    const steps = Math.round(durationMs / 100);
    let step = 0;
    this._smoothIv = setInterval(() => {
      step++;
      const t = step / steps;
      const cur = {
        Kp: from.Kp + (to.Kp - from.Kp) * t,
        Ki: from.Ki + (to.Ki - from.Ki) * t,
        Kd: from.Kd + (to.Kd - from.Kd) * t
      };
      // Apply to physics
      this.pidX.Kp = cur.Kp; this.pidX.Ki = cur.Ki; this.pidX.Kd = cur.Kd;
      this.pidY.Kp = cur.Kp; this.pidY.Ki = cur.Ki; this.pidY.Kd = cur.Kd;
      updateCurrentParamsUI(cur, from);
      if (step >= steps) { clearInterval(this._smoothIv); this._smoothIv = null; }
    }, 100);
  }

  // Process one physics step of dt seconds
  step(dt) {
    if (!this.isRunning) return;
    const prevM = this.conditions.m;
    const prevL = this.conditions.L;
    this.scenarioTime += dt;

    // Fire scenario events
    this._applyScenarioEvents();

    // Detect mass change → force immediate AI update
    if (Math.abs(this.conditions.m - prevM) > 5) {
      const reason = `mass ${Math.round(prevM)}→${Math.round(this.conditions.m)} kg`;
      this.forceUpdate(reason);
    }

    // Periodic AI update every updateEvery seconds
    if (this.scenarioTime - this.lastUpdate >= this.updateEvery) {
      this.lastUpdate = this.scenarioTime;
      const c = this.conditions;
      this.requestPrediction(c.L, c.m, c.wind_speed, c.wind_dir)
        .then(r => this.applyParams(r, 'periodic_update'));
    }

    // Update pendulum physics parameters
    this.pendulum.L = this.conditions.L;
    this.pendulum.m = this.conditions.m;

    // Wind forces
    const windRad = (this.conditions.wind_dir * Math.PI) / 180;
    const F_wind_x = this.conditions.wind_speed * Math.sin(windRad);
    const F_wind_y = this.conditions.wind_speed * Math.cos(windRad);

    // PID — same pattern as ui.js
    const pidFx = this.pidX.compute(this.pendulum.state.theta_x, dt);
    const pidFy = this.pidY.compute(this.pendulum.state.theta_y, dt);
    this.mixer.mix(pidFx, pidFy, 0);
    const forceScale = 1.0 / this.mixer.scale;
    const pwmForce  = this.mixer.getForce(0);
    const F_prop_x  = pwmForce.Fx * forceScale;
    const F_prop_y  = pwmForce.Fy * forceScale;
    const pwm       = this.mixer.pwm;

    this.pendulum.step(dt, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    // Record timeseries every second
    if (this.scenarioTime - this._lastTsRecord >= 1.0) {
      this._lastTsRecord = this.scenarioTime;
      const theta = Math.hypot(this.pendulum.state.theta_x, this.pendulum.state.theta_y);
      this.timeseries.push({
        t:     Math.round(this.scenarioTime),
        theta: +(theta * 180 / Math.PI).toFixed(3),
        Kp:    +this.params.Kp.toFixed(3),
        Ki:    +this.params.Ki.toFixed(4),
        Kd:    +this.params.Kd.toFixed(3)
      });
    }

    // Accumulate metrics
    const theta = Math.hypot(this.pendulum.state.theta_x, this.pendulum.state.theta_y);
    this.metrics.sumTheta += theta * dt;
    this.metrics.maxTheta  = Math.max(this.metrics.maxTheta, theta);
    this.metrics.frames++;

    // Update renderer
    if (this.renderer) {
      this.renderer.update(
        this.pendulum.state, pwm,
        this.conditions.wind_speed, this.conditions.wind_dir,
        this.conditions.L
      );
      this.renderer.setLoadVisible(true, this.conditions.m);
    }

    // Update scenario time display
    updateScenarioTimeUI(this.scenarioTime);

    // End of scenario
    if (this.scenarioTime >= 360) this._onScenarioEnd();
  }

  _applyScenarioEvents() {
    const scenario = window.AI_SCENARIO;
    if (!scenario) return;
    scenario.events.forEach((ev, idx) => {
      if (this.firedEvents.has(idx)) return;
      if (this.scenarioTime < ev.t) return;
      this.firedEvents.add(idx);

      if (ev.type === 'set') {
        Object.assign(this.conditions, ev.params);
        this._syncPhysics();
      } else if (ev.type === 'ramp') {
        const startVals = {};
        Object.keys(ev.params).forEach(k => { startVals[k] = this.conditions[k]; });
        const startT = this.scenarioTime;
        const rampIv = setInterval(() => {
          const elapsed  = this.scenarioTime - startT;
          const progress = Math.min(elapsed / ev.duration, 1);
          Object.keys(ev.params).forEach(k => {
            this.conditions[k] = startVals[k] + (ev.params[k] - startVals[k]) * progress;
          });
          this._syncPhysics();
          if (progress >= 1) clearInterval(rampIv);
        }, 50);
      } else if (ev.type === 'gust') {
        const orig = this.conditions.wind_speed;
        this.conditions.wind_speed *= ev.params.multiplier;
        setTimeout(() => { this.conditions.wind_speed = orig; },
          ev.params.duration * 1000);
      } else if (ev.type === 'rotate') {
        if (this.renderer) {
          this.renderer.animateYaw(ev.params.yaw_delta, ev.duration * 1000);
        }
      }
      updateConditionsUI(this.conditions);
      updateScenarioPhaseBanner(this.scenarioTime);
    });
  }

  _syncPhysics() {
    if (this.pendulum) {
      this.pendulum.L = this.conditions.L;
      this.pendulum.m = this.conditions.m;
    }
  }

  _onScenarioEnd() {
    this.isRunning = false;
    updatePlayBtn(false);
    const data = this._buildSessionData();
    this._saveSession(data);
    showFinishBanner(data);
  }

  _buildSessionData() {
    const avgTheta = this.metrics.frames > 0
      ? (this.metrics.sumTheta / this.metrics.frames) * (180 / Math.PI)
      : 0;
    return {
      session_id:  `session_${Date.now()}`,
      timestamp:   new Date().toISOString(),
      scenario:    'crane_6min_v1',
      duration_s:  360,
      metrics: {
        avg_theta_deg:  +avgTheta.toFixed(3),
        max_theta_deg:  +(this.metrics.maxTheta * 180 / Math.PI).toFixed(3),
        ai_updates:     this.history.length,
        forced_updates: this.history.filter(h => h.forced).length
      },
      ai_decisions: this.history,
      timeseries:   this.timeseries,
      phases:       this.metrics.perPhase
    };
  }

  async _saveSession(data) {
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch (e) {
      console.warn('Failed to save session:', e);
    }
  }
}

// ============================================================
// State
// ============================================================

const aiController = new AIController();
let aiRenderer = null;
let aiAnimRunning = false;
let aiLastTime = null;
let aiAccumulator = 0;
const AI_DT = 0.016;

// Telemetry chart data
const TV_TRAIL_MAX = 600;
const tvTrail = [];
const thetaHistory = [];
const THETA_CHART_SECONDS = 60;

// ============================================================
// Animation Loop
// ============================================================

function startAILoop() {
  if (aiAnimRunning) return;
  aiAnimRunning = true;
  aiLastTime = null;
  aiAccumulator = 0;
  requestAnimationFrame(aiLoop);
}

function stopAILoop() {
  aiAnimRunning = false;
  aiLastTime = null;
}

function aiLoop(now) {
  if (!aiAnimRunning) return;
  requestAnimationFrame(aiLoop);

  if (!aiLastTime) { aiLastTime = now; return; }
  let wallDt = (now - aiLastTime) / 1000;
  aiLastTime = now;
  wallDt = Math.min(wallDt, 0.1);

  aiAccumulator += wallDt;
  while (aiAccumulator >= AI_DT) {
    if (aiController.isRunning) aiController.step(AI_DT);
    aiAccumulator -= AI_DT;
  }

  // Draw top-down view
  drawTopView();

  // Draw telemetry chart
  const theta = Math.hypot(
    aiController.pendulum.state.theta_x,
    aiController.pendulum.state.theta_y
  ) * 180 / Math.PI;
  thetaHistory.push(theta);
  if (thetaHistory.length > THETA_CHART_SECONDS * 60) thetaHistory.shift();
  drawTelemetryChart();

  // Update telemetry numbers
  updateTelemetryNumbers();
}

// ============================================================
// UI Update Functions
// ============================================================

function updateModelStatus(model, confidence) {
  const el = document.getElementById('ai-model-name');
  const confEl = document.getElementById('ai-confidence');
  const dotEl  = document.getElementById('ai-status-dot');
  if (el) el.textContent = model || 'unknown';
  if (confEl) confEl.textContent = confidence != null
    ? `${Math.round(confidence * 100)}%` : '—';
  if (dotEl) {
    const isFallback = !model || model.includes('fallback');
    dotEl.className = isFallback ? 'ai-dot ai-dot-warn' : 'ai-dot ai-dot-ok';
  }
  const nextEl = document.getElementById('ai-next-update');
  if (nextEl) {
    const remaining = Math.max(0,
      aiController.updateEvery - (aiController.scenarioTime - aiController.lastUpdate));
    nextEl.textContent = `${Math.round(remaining)}s`;
  }
  // Also update update count
  const cntEl = document.getElementById('ai-update-count');
  if (cntEl) cntEl.textContent = aiController.history.length;
}

function updateCurrentParamsUI(params, prev) {
  ['Kp', 'Ki', 'Kd'].forEach(k => {
    const valEl   = document.getElementById(`ai-param-${k}`);
    const prevEl  = document.getElementById(`ai-param-${k}-prev`);
    const barEl   = document.getElementById(`ai-param-${k}-bar`);
    if (!valEl) return;
    const maxVal  = { Kp: 25, Ki: 0.5, Kd: 12 }[k] || 1;
    const digits  = k === 'Ki' ? 3 : 2;
    valEl.textContent = params[k].toFixed(digits);
    if (prevEl && prev) {
      const delta = params[k] - prev[k];
      const sign  = delta > 0 ? '+' : '';
      prevEl.textContent = `prev: ${prev[k].toFixed(digits)}  Δ${sign}${delta.toFixed(digits)}`;
      valEl.className = delta > 0.001 ? 'ai-param-val up' : delta < -0.001 ? 'ai-param-val down' : 'ai-param-val';
    }
    if (barEl) {
      barEl.style.width = Math.min(100, (params[k] / maxVal) * 100) + '%';
    }
  });
}

function updateConditionsUI(cond) {
  const phaseLabel = getCurrentPhaseLabel(aiController.scenarioTime);
  const phaseEl = document.getElementById('ai-cond-phase');
  if (phaseEl) phaseEl.textContent = phaseLabel;

  const Lel = document.getElementById('ai-cond-L');
  if (Lel) Lel.textContent = `${cond.L.toFixed(1)} m`;
  const mel = document.getElementById('ai-cond-m');
  if (mel) mel.textContent = `${Math.round(cond.m)} kg`;
  const wel = document.getElementById('ai-cond-wind');
  if (wel) wel.textContent = `${cond.wind_speed.toFixed(1)} m/s  ${Math.round(cond.wind_dir)}°`;
}

function updateDecisionHistoryUI(history) {
  const el = document.getElementById('ai-decision-list');
  if (!el) return;
  if (history.length === 0) {
    el.innerHTML = '<div class="ai-hist-empty">No decisions yet</div>';
    return;
  }
  const items = [...history].reverse().slice(0, 50).map(h => {
    const t = formatTime(h.t);
    const delta = `Kp ${h.prevKp?.toFixed(2) ?? '—'}→${h.Kp.toFixed(2)}`;
    const icon  = h.forced ? '⚡' : h.fallback ? '⚠' : '→';
    const reasonLabel = h.reason.replace(/_/g, ' ');
    return `<div class="ai-hist-item ${h.forced ? 'forced' : ''}">
      <span class="ai-hist-t">${t}</span>
      <span class="ai-hist-delta">${icon} ${delta}</span>
      <span class="ai-hist-reason">${reasonLabel}</span>
    </div>`;
  });
  el.innerHTML = items.join('');
}

function updateMetricsUI(metrics) {
  const avg = metrics.frames > 0
    ? (metrics.sumTheta / metrics.frames * 180 / Math.PI).toFixed(2)
    : '—';
  const max = (metrics.maxTheta * 180 / Math.PI).toFixed(2);
  const el = (id) => document.getElementById(id);
  if (el('ai-metric-avg'))     el('ai-metric-avg').textContent     = avg + '°';
  if (el('ai-metric-max'))     el('ai-metric-max').textContent     = max + '°';
  if (el('ai-metric-updates')) el('ai-metric-updates').textContent = aiController.history.length;
}

function updateTelemetryNumbers() {
  const state = aiController.pendulum.state;
  const theta = Math.hypot(state.theta_x, state.theta_y) * 180 / Math.PI;
  const el = (id) => document.getElementById(id);
  if (el('ai-t-theta-x'))   el('ai-t-theta-x').textContent = (state.theta_x * 180 / Math.PI).toFixed(2) + '°';
  if (el('ai-t-theta-y'))   el('ai-t-theta-y').textContent = (state.theta_y * 180 / Math.PI).toFixed(2) + '°';
  if (el('ai-t-theta-abs')) el('ai-t-theta-abs').textContent = theta.toFixed(2) + '°';
  updateMetricsUI(aiController.metrics);
}

function updateScenarioTimeUI(t) {
  const el = document.getElementById('ai-scenario-time');
  if (el) el.textContent = `${formatTime(t)} / 6:00`;

  // Timeline progress bar
  const bar = document.getElementById('ai-timeline-progress');
  if (bar) bar.style.width = Math.min(100, (t / 360) * 100) + '%';

  // Next event label
  const scenario = window.AI_SCENARIO;
  if (!scenario) return;
  const nextEv = scenario.events.find((ev, i) =>
    !aiController.firedEvents.has(i) && ev.t > t);
  const nextEl = document.getElementById('ai-next-event');
  if (nextEl && nextEv) {
    const remaining = Math.round(nextEv.t - t);
    nextEl.textContent = `NEXT: ${nextEv.label}  (in ${remaining}s)`;
  } else if (nextEl) {
    nextEl.textContent = 'Scenario complete';
  }

  updateScenarioPhaseBanner(t);
}

function updateScenarioPhaseBanner(t) {
  const scenario = window.AI_SCENARIO;
  if (!scenario) return;
  const phase = scenario.phases.find(p => t >= p.t_start && t < p.t_end);
  if (!phase) return;

  const banner = document.getElementById('ai-phase-banner');
  if (banner) {
    banner.textContent = phase.label;
    banner.style.background = phase.color + '33';
    banner.style.borderColor = phase.color;
    banner.style.color       = phase.color;
  }
  const phaseBar = document.getElementById('ai-phase-indicator');
  if (phaseBar) {
    phaseBar.textContent = phase.label;
    phaseBar.style.background = phase.color;
  }
}

function updateOllamaPanel(text) {
  const el = document.getElementById('ai-ollama-text');
  if (el) el.textContent = text || '—';
}

function updatePlayBtn(running) {
  const btn = document.getElementById('ai-btn-play');
  if (!btn) return;
  btn.textContent = running ? '⏸ PAUSE' : '▶ START';
  btn.dataset.state = running ? 'running' : 'paused';
}

function getCurrentPhaseLabel(t) {
  const scenario = window.AI_SCENARIO;
  if (!scenario) return '—';
  const phase = scenario.phases.find(p => t >= p.t_start && t < p.t_end);
  return phase ? phase.label : '—';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function showFinishBanner(data) {
  const avg = data.metrics.avg_theta_deg.toFixed(2);
  const max = data.metrics.max_theta_deg.toFixed(2);
  const el = document.getElementById('ai-finish-banner');
  if (el) {
    el.innerHTML = `<strong>Scenario complete!</strong>  Avg θ: ${avg}°  Max θ: ${max}°  AI updates: ${data.metrics.ai_updates} — Session saved to REPORTS`;
    el.style.display = 'block';
  }
}

// ============================================================
// Canvas: Top-Down View
// ============================================================

function drawTopView() {
  const canvas = document.getElementById('ai-topview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const scale = W / 2 / 20; // 20 degrees = half width

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Reference circles: 5°, 10°, 15°
  [5, 10, 15].forEach((deg, i) => {
    ctx.beginPath();
    ctx.arc(cx, cy, deg * scale, 0, Math.PI * 2);
    ctx.strokeStyle = i === 2 ? '#ff4444' : i === 1 ? '#ff9d00' : '#2a3441';
    ctx.lineWidth = 1;
    ctx.setLineDash(i === 2 ? [4, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    if (i < 2) {
      ctx.fillStyle = '#3a4a5a';
      ctx.font = '9px monospace';
      ctx.fillText(`${deg}°`, cx + deg * scale + 2, cy - 2);
    }
  });

  // Trail
  const state = aiController.pendulum.state;
  const px = state.theta_x * 180 / Math.PI;
  const pz = state.theta_y * 180 / Math.PI;

  tvTrail.push({ x: cx + px * scale, y: cy + pz * scale });
  if (tvTrail.length > TV_TRAIL_MAX) tvTrail.shift();

  if (tvTrail.length > 1) {
    ctx.beginPath();
    ctx.moveTo(tvTrail[0].x, tvTrail[0].y);
    tvTrail.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = 'rgba(0,212,170,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Load dot
  ctx.beginPath();
  ctx.arc(cx + px * scale, cy + pz * scale, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#00d4aa';
  ctx.fill();

  // Wind indicator
  const windRad = (aiController.conditions.wind_dir * Math.PI / 180);
  const wLen = Math.min(aiController.conditions.wind_speed * 1.5, 40);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(windRad) * wLen, cy + Math.cos(windRad) * wLen);
  ctx.strokeStyle = '#4da6ff88';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ============================================================
// Canvas: Telemetry theta(t) chart (60s rolling)
// ============================================================

function drawTelemetryChart() {
  const canvas = document.getElementById('ai-telemetry-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const maxPts = THETA_CHART_SECONDS * 60;
  const data   = thetaHistory;
  if (data.length < 2) return;

  // Axes
  const pad = { l: 30, r: 8, t: 8, b: 20 };
  const iW  = W - pad.l - pad.r;
  const iH  = H - pad.t - pad.b;
  const maxDeg = 20;

  // 15° warning line
  const y15 = pad.t + iH * (1 - 15 / maxDeg);
  ctx.beginPath();
  ctx.moveTo(pad.l, y15);
  ctx.lineTo(W - pad.r, y15);
  ctx.strokeStyle = '#ff444455';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // Plot theta
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad.l + (i / maxPts) * iW;
    const y = pad.t + iH * (1 - Math.min(v, maxDeg) / maxDeg);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00d4aa';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Y axis label
  ctx.fillStyle = '#8b949e';
  ctx.font = '9px monospace';
  ctx.fillText('15°', 2, y15 + 3);
  ctx.fillText('|θ|', 2, pad.t + 8);
}

// ============================================================
// Init & Event Wiring
// ============================================================

function initAITab() {
  const mount = document.getElementById('ai-scene-mount');
  if (!mount || aiRenderer) return;

  // Create second 3D renderer for AI DRIVEN tab
  aiRenderer = new CraneRenderer(mount);
  aiController.renderer = aiRenderer;

  // Initial load state
  aiRenderer.setLoadVisible(true, aiController.conditions.m);

  // Wire buttons
  document.getElementById('ai-btn-play')?.addEventListener('click', () => {
    if (!aiController.isRunning) {
      aiController.isRunning = true;
      updatePlayBtn(true);
      startAILoop();
      // Initial AI prediction
      const c = aiController.conditions;
      aiController.requestPrediction(c.L, c.m, c.wind_speed, c.wind_dir)
        .then(r => aiController.applyParams(r, 'start'));
    } else {
      aiController.isRunning = false;
      updatePlayBtn(false);
    }
  });

  document.getElementById('ai-btn-reset')?.addEventListener('click', () => {
    aiController.isRunning = false;
    stopAILoop();
    updatePlayBtn(false);
    aiController.reset();
    tvTrail.length = 0;
    thetaHistory.length = 0;
    const banner = document.getElementById('ai-finish-banner');
    if (banner) banner.style.display = 'none';
    // Reset renderer trail and yaw
    if (aiRenderer) {
      aiRenderer.resetTrail();
      aiRenderer._yawOffset = 0;
    }
    updateConditionsUI(aiController.conditions);
    updateCurrentParamsUI(aiController.params, aiController.params);
    updateScenarioTimeUI(0);
  });

  document.getElementById('ai-btn-ollama')?.addEventListener('click', () => {
    aiController.useOllama = !aiController.useOllama;
    const btn = document.getElementById('ai-btn-ollama');
    if (btn) {
      btn.textContent = `OLLAMA: ${aiController.useOllama ? 'ON' : 'OFF'}`;
      btn.dataset.active = aiController.useOllama ? 'true' : 'false';
    }
  });

  // Initial UI state
  updateConditionsUI(aiController.conditions);
  updateCurrentParamsUI(aiController.params, aiController.params);
  updateDecisionHistoryUI([]);
  updateScenarioTimeUI(0);

  // Check AI status to show model info
  fetch('/api/ai/status').then(r => r.json()).then(data => {
    if (data.trained && data.stats?.metrics) {
      const m = data.stats.metrics;
      const conf = (m.Kp?.r2 + m.Ki?.r2 + m.Kd?.r2) / 3;
      updateModelStatus('GradientBoosting', conf);
    } else {
      updateModelStatus('analytical_fallback', 0);
    }
  }).catch(() => updateModelStatus('analytical_fallback', 0));
}

// Activate when tab is clicked
window.addEventListener('ai-tab-activated', () => {
  if (!aiRenderer) {
    initAITab();
  }
  // Make sure the loop renders at least one frame
  if (!aiAnimRunning) {
    aiAnimRunning = true;
    aiLastTime = null;
    requestAnimationFrame(function oneFrame(now) {
      aiLastTime = now;
      drawTopView();
      drawTelemetryChart();
      aiAnimRunning = false;
    });
  }
});
