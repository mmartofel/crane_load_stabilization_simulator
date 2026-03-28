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
    this.pidEnabled  = true;

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
    this.metrics     = {
      sumTheta: 0, maxTheta: 0, frames: 0, perPhase: {},
      maxThetaX: 0, maxThetaY: 0,   // per-axis max (radians)
      framesWithin5: 0, framesWithin5X: 0, framesWithin5Y: 0  // quality gate counts
    };

    this.pidEnabled  = true;
    this.pendulum = new Pendulum({ L: this.conditions.L, m: this.conditions.m });
    this.pidX     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.pidY     = new PIDController({ Kp: this.params.Kp, Ki: this.params.Ki, Kd: this.params.Kd });
    this.mixer    = new PropellerMixer();

    if (this._smoothIv) { clearInterval(this._smoothIv); this._smoothIv = null; }
    // Reset stabilizer button state
    const pidBtn = document.getElementById('ai-btn-pid');
    if (pidBtn) { pidBtn.dataset.active = 'true'; pidBtn.textContent = 'STABILIZER: ON'; }

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
        signal: AbortSignal.timeout(this.useOllama ? 15000 : 3000)
      });
      const data = await resp.json();
      console.log('[AI] predict response:', {
        model: data.model, fallback: data.fallback,
        hasExplanation: !!data.explanation,
        explanation: typeof data.explanation === 'string' ? data.explanation.slice(0, 80) : data.explanation
      });
      return data;
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
    // updateConfidencePanel is already called inside applyParams
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
      t:               this.scenarioTime,
      Kp:              this.params.Kp,
      Ki:              this.params.Ki,
      Kd:              this.params.Kd,
      prevKp:          this.prevParams.Kp,
      prevKi:          this.prevParams.Ki,
      prevKd:          this.prevParams.Kd,
      reason, forced,
      confidence:      result.confidence,
      confidence_detail: result.confidence_detail ?? null,
      conf_label:      result.confidence_label  ?? null,
      conf_hint:       result.confidence_hint   ?? null,
      in_range:        result.in_training_range ?? null,
      fallback:        result.fallback || false,
      explanation:     result.explanation || null
    });
    updateDecisionHistoryUI(this.history);
    updateCurrentParamsUI(this.params, this.prevParams);
    console.log('[AI] applyParams — explanation:', result.explanation,
                '| useOllama:', this.useOllama, '| fallback:', result.fallback);
    if (this.useOllama) {
      if (result.explanation) {
        updateOllamaPanel(result.explanation);
      } else if (result.fallback) {
        updateOllamaPanel('⚠ AI service offline — analytical fallback');
      } else {
        updateOllamaPanel('⚠ Ollama: no response received');
      }
    }
    updateConfidencePanel(result);
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

    // PID — same pattern as ui.js; zero forces when stabilizer disabled
    let F_prop_x = 0, F_prop_y = 0;
    let pwm = [0, 0, 0, 0];
    if (this.pidEnabled) {
      const pidFx = this.pidX.compute(this.pendulum.state.theta_x, dt);
      const pidFy = this.pidY.compute(this.pendulum.state.theta_y, dt);
      this.mixer.mix(pidFx, pidFy, 0);
      const forceScale = 1.0 / this.mixer.scale;
      const pwmForce  = this.mixer.getForce(0);
      F_prop_x  = pwmForce.Fx * forceScale;
      F_prop_y  = pwmForce.Fy * forceScale;
      pwm       = this.mixer.pwm;
    }

    this.pendulum.step(dt, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

    // Update motor bars
    updateMotorBars(pwm);

    // Record timeseries every second
    if (this.scenarioTime - this._lastTsRecord >= 1.0) {
      this._lastTsRecord = this.scenarioTime;
      const theta = Math.hypot(this.pendulum.state.theta_x, this.pendulum.state.theta_y);
      this.timeseries.push({
        t:          Math.round(this.scenarioTime),
        theta:      +(theta * 180 / Math.PI).toFixed(3),
        theta_x:    +this.pendulum.state.theta_x.toFixed(5),
        theta_y:    +this.pendulum.state.theta_y.toFixed(5),
        theta_x_deg: +(this.pendulum.state.theta_x * 180 / Math.PI).toFixed(3),
        theta_y_deg: +(this.pendulum.state.theta_y * 180 / Math.PI).toFixed(3),
        Kp:         +this.params.Kp.toFixed(3),
        Ki:         +this.params.Ki.toFixed(4),
        Kd:         +this.params.Kd.toFixed(3),
        wind_speed: +this.conditions.wind_speed.toFixed(2),
        wind_dir:   +this.conditions.wind_dir.toFixed(1)
      });
    }

    // Accumulate metrics
    const theta  = Math.hypot(this.pendulum.state.theta_x, this.pendulum.state.theta_y);
    const absTx  = Math.abs(this.pendulum.state.theta_x);
    const absTy  = Math.abs(this.pendulum.state.theta_y);
    const DEG5   = 5 * Math.PI / 180;
    this.metrics.sumTheta   += theta * dt;
    this.metrics.maxTheta    = Math.max(this.metrics.maxTheta, theta);
    this.metrics.maxThetaX   = Math.max(this.metrics.maxThetaX, absTx);
    this.metrics.maxThetaY   = Math.max(this.metrics.maxThetaY, absTy);
    this.metrics.frames++;
    if (absTx < DEG5 && absTy < DEG5) this.metrics.framesWithin5++;
    if (absTx < DEG5)                  this.metrics.framesWithin5X++;
    if (absTy < DEG5)                  this.metrics.framesWithin5Y++;

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
    stopAILoop();
    updatePlayBtn(false);
    document.getElementById('ai-btn-play')?.classList.remove('running');
    const data = this._buildSessionData();
    this._saveSession(data);
    showFinishBanner(data);
  }

  _buildSessionData() {
    const avgTheta = this.metrics.frames > 0
      ? (this.metrics.sumTheta / this.metrics.frames) * (180 / Math.PI)
      : 0;
    return {
      session_id:    `session_${Date.now()}`,
      timestamp:     new Date().toISOString(),
      scenario:      'crane_6min_v1',
      duration_s:    360,
      stabilizer_on: this.pidEnabled,   // final stabilizer state for REPORTS model info display
      model_info:    capturedModelInfo, // AI service status snapshot taken at tab activation
      metrics: {
        avg_theta_deg:    +avgTheta.toFixed(3),
        max_theta_deg:    +(this.metrics.maxTheta  * 180 / Math.PI).toFixed(3),
        max_theta_x_deg:  +(this.metrics.maxThetaX * 180 / Math.PI).toFixed(3),
        max_theta_y_deg:  +(this.metrics.maxThetaY * 180 / Math.PI).toFixed(3),
        pct_within_5deg:  this.metrics.frames > 0
          ? +(this.metrics.framesWithin5  / this.metrics.frames * 100).toFixed(1) : 0,
        pct_within_5deg_x: this.metrics.frames > 0
          ? +(this.metrics.framesWithin5X / this.metrics.frames * 100).toFixed(1) : 0,
        pct_within_5deg_y: this.metrics.frames > 0
          ? +(this.metrics.framesWithin5Y / this.metrics.frames * 100).toFixed(1) : 0,
        ai_updates:       this.history.length,
        forced_updates:   this.history.filter(h => h.forced).length
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
let capturedModelInfo = null;   // snapshot of /api/ai/status stored at tab activation, embedded in session JSON
let aiAnimRunning = false;
let aiLastTime = null;
let aiAccumulator = 0;
const AI_DT = 0.016;

// Telemetry chart data
const TV_TRAIL_MAX = 1800;   // ~30 s @ 60 fps, matches 3D renderer trail length
const tvTrail = [];
const thetaHistory = [];
const THETA_CHART_SECONDS = 60;

// 3-channel angle chart (30s rolling — matches Top View trail and 3D trail)
const aiGraphData = { tx: [], ty: [], tabs: [] };
const AI_GRAPH_MAX = 1800;   // 30 s @ 60 fps

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

  // Push to 3-channel angle chart (θx, θy, |θ|)
  const atx = aiController.pendulum.state.theta_x * 180 / Math.PI;
  const aty = aiController.pendulum.state.theta_y * 180 / Math.PI;
  aiGraphData.tx.push(atx);
  aiGraphData.ty.push(aty);
  aiGraphData.tabs.push(Math.hypot(atx, aty));
  if (aiGraphData.tx.length > AI_GRAPH_MAX) {
    aiGraphData.tx.shift(); aiGraphData.ty.shift(); aiGraphData.tabs.shift();
  }
  drawAiAngleChart();

  // Update telemetry numbers
  updateTelemetryNumbers();
}

// ============================================================
// UI Update Functions
// ============================================================

function updateConfidencePanel(result) {
  const conf   = result.confidence   ?? 0;
  const detail = result.confidence_detail ?? {};
  const label  = result.confidence_label  ?? (window.confidenceLabel ? window.confidenceLabel(conf) : '');
  const hint   = result.confidence_hint   ?? null;
  const inRange = result.in_training_range;
  const model  = result.model || 'unknown';

  // Model name and status dot
  const nameEl = document.getElementById('ai-model-name');
  if (nameEl) nameEl.textContent = model;
  const dotEl  = document.getElementById('ai-status-dot');
  if (dotEl) {
    const isFallback = !model || model.includes('fallback');
    dotEl.className = isFallback ? 'ai-dot ai-dot-warn' : 'ai-dot ai-dot-ok';
  }

  // Main confidence bar
  const color = window.confidenceColor ? window.confidenceColor(conf) : '#00d4aa';
  const fillEl = document.getElementById('conf-bar-fill');
  if (fillEl) {
    fillEl.style.width      = (conf * 100).toFixed(0) + '%';
    fillEl.style.background = color;
  }
  const valEl = document.getElementById('conf-value');
  if (valEl) valEl.textContent = conf.toFixed(2);
  const lblEl = document.getElementById('conf-label');
  if (lblEl) {
    lblEl.textContent = label;
    lblEl.style.color = color;
  }

  // Mini bars per parameter
  ['Kp', 'Ki', 'Kd'].forEach(p => {
    const r2  = detail[p] ?? conf;
    const c   = window.confidenceColor ? window.confidenceColor(r2) : '#00d4aa';
    const bar = document.getElementById(`conf-bar-${p.toLowerCase()}`);
    const val = document.getElementById(`conf-val-${p.toLowerCase()}`);
    if (bar) { bar.style.width = (r2 * 100).toFixed(0) + '%'; bar.style.background = c; }
    if (val) val.textContent = r2.toFixed(2);
  });

  // Updates count and next-update timer
  const cntEl  = document.getElementById('ai-update-count');
  if (cntEl) cntEl.textContent = aiController.history.length;
  const nextEl = document.getElementById('ai-next-update');
  if (nextEl) {
    const remaining = Math.max(0,
      aiController.updateEvery - (aiController.scenarioTime - aiController.lastUpdate));
    nextEl.textContent = `${Math.round(remaining)}s`;
  }

  // Warning / fallback banner
  const banner = document.getElementById('conf-banner');
  if (banner) {
    if (conf < 0.50) {
      banner.className = 'conf-banner conf-banner-fallback';
      banner.innerHTML = `<strong>✗ FALLBACK MODE</strong> — ${hint || 'No data. Collect PID test results and rebuild the model.'}`;
      banner.style.display = '';
    } else if (conf < 0.75) {
      banner.className = 'conf-banner conf-banner-warn';
      banner.innerHTML = `<strong>⚠ LOW CONFIDENCE</strong> — ${hint || 'Prediction is approximate.'}`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  }

  // Out-of-training-range banner
  const rangeBanner = document.getElementById('conf-range-banner');
  if (rangeBanner) {
    if (inRange === false) {
      rangeBanner.textContent = '⚠ Conditions outside training data range — extrapolation';
      rangeBanner.style.display = '';
    } else {
      rangeBanner.style.display = 'none';
    }
  }
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
  const items = [...history].reverse().slice(0, 3).map(h => {
    const t = formatTime(h.t);
    const delta = `Kp ${h.prevKp?.toFixed(2) ?? '—'}→${h.Kp.toFixed(2)}`;
    const icon  = h.forced ? '⚡' : h.fallback ? '⚠' : '→';
    const reasonLabel = h.reason.replace(/_/g, ' ');
    const conf  = h.confidence;
    const confStr = conf != null
      ? `<span style="color:${window.confidenceColor ? window.confidenceColor(conf) : '#8b949e'};font-size:10px;font-family:var(--font-mono)"> [${conf.toFixed(2)}]</span>`
      : '';
    return `<div class="ai-hist-item ${h.forced ? 'forced' : ''}">
      <span class="ai-hist-t">${t}</span>
      <span class="ai-hist-delta">${icon} ${delta}${confStr}</span>
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

function updateMotorBars(pwm) {
  const labels = ['m1', 'm2', 'm3', 'm4'];
  pwm.forEach((val, i) => {
    const barEl = document.getElementById(`ai-${labels[i]}-bar`);
    const valEl = document.getElementById(`ai-${labels[i]}-val`);
    const pct   = Math.round(Math.abs(val) * 100);
    if (barEl) {
      barEl.style.width      = Math.min(100, pct) + '%';
      barEl.style.background = val >= 0 ? 'var(--accent)' : '#ff9d00';
    }
    if (valEl) valEl.textContent = `${val >= 0 ? '' : '-'}${pct}%`;
  });
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
  const headerEl = document.getElementById('ai-scenario-time-header');
  if (headerEl) headerEl.textContent = `${formatTime(t)} / 6:00`;

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
  console.log('[AI] updateOllamaPanel:', text?.slice?.(0, 60));
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

function drawArrow2D(ctx, ox, oy, dx, dy, len, color, lw) {
  const ex = ox + dx * len;
  const ey = oy + dy * len;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ex, ey);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 6 * Math.cos(angle - 0.4), ey - 6 * Math.sin(angle - 0.4));
  ctx.lineTo(ex - 6 * Math.cos(angle + 0.4), ey - 6 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawTopView() {
  const canvas = document.getElementById('ai-topview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const SCALE = 8; // px per degree

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Warning circle at 15°
  ctx.beginPath();
  ctx.arc(cx, cy, 15 * SCALE, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 68, 68, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Inner ref circles at 5° and 10°
  [5, 10].forEach(d => {
    ctx.beginPath();
    ctx.arc(cx, cy, d * SCALE, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Crosshair
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

  // Trail with gradient fade
  const state = aiController.pendulum.state;
  tvTrail.push({ x: state.theta_x, y: state.theta_y });
  if (tvTrail.length > TV_TRAIL_MAX) tvTrail.shift();

  if (tvTrail.length > 1) {
    ctx.beginPath();
    tvTrail.forEach((pt, i) => {
      const x = cx + pt.x * 180 / Math.PI * SCALE;
      const y = cy + pt.y * 180 / Math.PI * SCALE;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(0,212,170,0)');
    grad.addColorStop(1, 'rgba(0,212,170,0.6)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Wind arrow
  const wRad = (aiController.conditions.wind_dir * Math.PI) / 180;
  const wLen = Math.max(5, aiController.conditions.wind_speed * 2.5);
  const wox = cx - Math.sin(wRad) * (wLen + 10);
  const woy = cy - Math.cos(wRad) * (wLen + 10);
  drawArrow2D(ctx, wox, woy, Math.sin(wRad), Math.cos(wRad), wLen, '#4da6ff', 1.5);
  // Wind parameters label near arrow origin
  ctx.fillStyle = '#4da6ff';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${aiController.conditions.wind_speed.toFixed(1)} m/s  ${aiController.conditions.wind_dir.toFixed(0)}\u00b0`, wox, woy - 6);

  // Propeller force vectors (M1–M4 / N,E,S,W) from centre
  const propAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // M1=N, M2=E, M3=S, M4=W
  const propLabels = ['M1', 'M2', 'M3', 'M4'];
  let net_ax = 0, net_ay = 0;
  aiController.mixer.pwm.forEach((p, i) => {
    const ax = Math.sin(propAngles[i]);
    const ay = -Math.cos(propAngles[i]);
    const aLen = Math.abs(p) * 65;
    if (aLen > 1.5) {
      const col = Math.abs(p) > 0.05 ? '#00d4aa' : '#334455';
      drawArrow2D(ctx, cx, cy, ax, ay, aLen, col, 2);
    }
    net_ax += ax * p;
    net_ay += ay * p;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(propLabels[i], cx + ax * 36, cy + ay * 36 + 3);
  });

  // Net resultant force vector
  const netMag = Math.sqrt(net_ax * net_ax + net_ay * net_ay);
  const netLen = netMag * 65;
  if (netLen > 2) {
    const nd = 1 / netMag;
    drawArrow2D(ctx, cx, cy, net_ax * nd, net_ay * nd, netLen, 'rgba(255,255,255,0.6)', 2.5);
  }

  // Load dot — color-coded by angle
  const { theta_x, theta_y } = aiController.pendulum.state;
  const lx = cx + theta_x * 180 / Math.PI * SCALE;
  const ly = cy + theta_y * 180 / Math.PI * SCALE;
  const tabs = Math.sqrt(theta_x * theta_x + theta_y * theta_y) * 180 / Math.PI;
  const dotColor = tabs > 15 ? '#ff4444' : tabs > 8 ? '#ff9d00' : '#00d4aa';

  ctx.beginPath();
  ctx.arc(lx, ly, 5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Load parameters label
  ctx.fillStyle = dotColor;
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(aiController.conditions.m)} kg  L:${aiController.conditions.L.toFixed(1)} m`, lx + 8, ly + 3);

  // Centre dot
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fill();

  // Scale label
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${SCALE}px/°`, 6, H - 6);
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
// Canvas: 3-channel Angle Chart (30s rolling)
// ============================================================

function drawAiAngleChart() {
  const canvas = document.getElementById('ai-angle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 28, r: 6, t: 6, b: 18 };
  const iW  = W - pad.l - pad.r;
  const iH  = H - pad.t - pad.b;
  const maxDeg = 20;
  const n    = AI_GRAPH_MAX;

  // Grid lines at every 5° (positive and negative)
  ctx.lineWidth = 1;
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  [-15, -10, -5, 0, 5, 10, 15].forEach(deg => {
    const y = pad.t + iH * (1 - (deg + maxDeg) / (2 * maxDeg));
    ctx.strokeStyle = deg === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
    ctx.setLineDash(deg === 0 ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText(`${deg}°`, pad.l - 2, y + 3);
  });

  // ±15° dashed red warning lines
  [-15, 15].forEach(deg => {
    const y = pad.t + iH * (1 - (deg + maxDeg) / (2 * maxDeg));
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y);
    ctx.strokeStyle = 'rgba(255,68,68,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Helper: draw one series
  function drawSeries(data, color) {
    if (data.length < 2) return;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad.l + (i / n) * iW;
      const y = pad.t + iH * (1 - (Math.max(-maxDeg, Math.min(maxDeg, v)) + maxDeg) / (2 * maxDeg));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Draw |θ| (gray, behind)
  drawSeries(aiGraphData.tabs, 'rgba(200,200,200,0.8)');
  // Draw θx (blue)
  drawSeries(aiGraphData.tx, '#4da6ff');
  // Draw θy (orange)
  drawSeries(aiGraphData.ty, '#ff9d00');

  // X-axis labels: -30s … 0s
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('-30s', pad.l, H - 4);
  ctx.fillText('0s',   W - pad.r, H - 4);

  // Legend (top-right)
  const lx = W - pad.r - 2;
  const ly = pad.t + 4;
  [['θx', '#4da6ff'], ['θy', '#ff9d00'], ['|θ|', 'rgba(200,200,200,0.8)']].forEach(([label, col], i) => {
    ctx.fillStyle = col;
    ctx.textAlign = 'right';
    ctx.fillText(label, lx, ly + i * 11);
  });
}

// ============================================================
// Init & Event Wiring
// ============================================================

// Fetch AI service status and update the Model Status panel.
// Called on every tab activation so the panel stays in sync with experiments_config.json.
function refreshModelStatus() {
  fetch('/api/ai/status').then(r => r.json()).then(data => {
    capturedModelInfo = data;   // snapshot for embedding in the session JSON at scenario end
    const modelName = data.model_id || (data.trained ? 'GradientBoosting' : 'analytical_fallback');
    if (data.trained && data.stats?.metrics) {
      const m = data.stats.metrics;
      const conf = ((m.Kp?.r2 || 0) + (m.Ki?.r2 || 0) + (m.Kd?.r2 || 0)) / 3;
      updateConfidencePanel({
        model: modelName,
        confidence: conf,
        confidence_detail: { Kp: m.Kp?.r2 || 0, Ki: m.Ki?.r2 || 0, Kd: m.Kd?.r2 || 0 },
        confidence_label: null, confidence_hint: null, in_training_range: null
      });
    } else {
      updateConfidencePanel({ model: 'analytical_fallback', confidence: 0,
        confidence_detail: {Kp:0, Ki:0, Kd:0}, confidence_label: 'FALLBACK',
        confidence_hint: null, in_training_range: null });
    }
  }).catch(() => updateConfidencePanel({ model: 'analytical_fallback', confidence: 0,
    confidence_detail: {Kp:0, Ki:0, Kd:0}, confidence_label: 'FALLBACK',
    confidence_hint: null, in_training_range: null }));
}

function initAITab() {
  const mount = document.getElementById('ai-scene-mount');
  if (!mount || aiRenderer) return;

  // Create second 3D renderer for AI DRIVEN tab
  aiRenderer = new CraneRenderer(mount);
  aiController.renderer = aiRenderer;

  // Initial load state
  aiRenderer.setLoadVisible(true, aiController.conditions.m);

  // Wire buttons
  document.getElementById('ai-btn-play')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (!aiController.isRunning) {
      aiController.isRunning = true;
      updatePlayBtn(true);
      btn.classList.add('running');
      startAILoop();
      // Initial AI prediction
      const c = aiController.conditions;
      aiController.requestPrediction(c.L, c.m, c.wind_speed, c.wind_dir)
        .then(r => aiController.applyParams(r, 'start'));
    } else {
      aiController.isRunning = false;
      updatePlayBtn(false);
      btn.classList.remove('running');
    }
  });

  document.getElementById('ai-btn-reset')?.addEventListener('click', () => {
    aiController.isRunning = false;
    stopAILoop();
    updatePlayBtn(false);
    document.getElementById('ai-btn-play')?.classList.remove('running');
    aiController.reset();
    tvTrail.length = 0;
    thetaHistory.length = 0;
    aiGraphData.tx.length = 0; aiGraphData.ty.length = 0; aiGraphData.tabs.length = 0;
    const banner = document.getElementById('ai-finish-banner');
    if (banner) banner.style.display = 'none';
    // Reset renderer trail, yaw, and snap load back to vertical
    if (aiRenderer) {
      aiRenderer.resetTrail();
      aiRenderer._yawOffset = 0;
      aiRenderer.update(
        aiController.pendulum.state,
        [0, 0, 0, 0],
        aiController.conditions.wind_speed,
        aiController.conditions.wind_dir,
        aiController.conditions.L
      );
    }
    updateConditionsUI(aiController.conditions);
    updateCurrentParamsUI(aiController.params, aiController.params);
    updateScenarioTimeUI(0);
    updateTelemetryNumbers();
    updateMotorBars([0, 0, 0, 0]);
    drawTopView();
    drawTelemetryChart();
    drawAiAngleChart();
  });

  document.getElementById('ai-btn-ollama')?.addEventListener('click', () => {
    aiController.useOllama = !aiController.useOllama;
    const btn = document.getElementById('ai-btn-ollama');
    if (btn) {
      btn.textContent = `OLLAMA: ${aiController.useOllama ? 'ON' : 'OFF'}`;
      btn.dataset.active = aiController.useOllama ? 'true' : 'false';
    }
  });

  document.getElementById('ai-btn-pid')?.addEventListener('click', () => {
    aiController.pidEnabled = !aiController.pidEnabled;
    const btn = document.getElementById('ai-btn-pid');
    if (btn) {
      btn.dataset.active = aiController.pidEnabled ? 'true' : 'false';
      btn.textContent = `STABILIZER: ${aiController.pidEnabled ? 'ON' : 'OFF'}`;
    }
    if (aiController.pidEnabled) {
      aiController.pidX.reset();
      aiController.pidY.reset();
    }
  });

  // Initial UI state
  updateConditionsUI(aiController.conditions);
  updateCurrentParamsUI(aiController.params, aiController.params);
  updateDecisionHistoryUI([]);
  updateScenarioTimeUI(0);

}

// Activate when tab is clicked
window.addEventListener('ai-tab-activated', () => {
  if (!aiRenderer) {
    initAITab();
  }
  // Always refresh model status so the panel reflects the currently active experiment
  refreshModelStatus();
  // Make sure the loop renders at least one frame
  if (!aiAnimRunning) {
    aiAnimRunning = true;
    aiLastTime = null;
    requestAnimationFrame(function oneFrame(now) {
      aiLastTime = now;
      drawTopView();
      drawTelemetryChart();
      drawAiAngleChart();
      aiAnimRunning = false;
    });
  }
});
