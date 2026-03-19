// ============================================================
// ui.js — Sliders, buttons, animation loop, top view, chart
// ============================================================

import { Pendulum, PIDController, PropellerMixer } from './sim.js';
import { CraneRenderer } from './renderer.js';
import { computePhysicsRanges } from './optimizer.js';

// ---- Simulation state ----
let running = false;
let pidEnabled = true;
let gustMode = false;
let impulseTimer = 0;
let gustTimer = 0;
let gustMagnitude = 0;
let yaw = 0;  // device yaw in radians

// ---- Sim parameters ----
let params = {
  windSpeed: 5,
  windDir: 45,
  L: 10,
  m: 50,
  Kp: 8.0,
  Ki: 0.1,
  Kd: 2.5,
};

// ---- Instances ----
let pendulum = new Pendulum({ L: params.L, m: params.m });
let pidX = new PIDController({ Kp: params.Kp, Ki: params.Ki, Kd: params.Kd });
let pidY = new PIDController({ Kp: params.Kp, Ki: params.Ki, Kd: params.Kd });
let mixer = new PropellerMixer();

// ---- Graph data ----
const GRAPH_SECONDS = 30;
const GRAPH_RATE = 60;
const GRAPH_MAX = GRAPH_SECONDS * GRAPH_RATE;
const graphData = { tx: [], ty: [], tabs: [] };

// ---- Top-view trail ----
const TV_TRAIL_MAX = 10 * 60; // 10s
const tvTrail = [];

// ---- Renderer ----
let craneRenderer = null;

// ---- Timing ----
let lastTime = null;
const SIM_DT = 0.016;
let simAccum = 0;

// ---- Wait for Three.js then init ----
function waitForThree() {
  if (window.THREE && window.THREE.OrbitControls) {
    init();
  } else {
    setTimeout(waitForThree, 50);
  }
}

function init() {
  const mount = document.getElementById('threejs-mount');
  craneRenderer = new CraneRenderer(mount);
  bindControls();
  updatePIDSliderBounds(params.L, params.m);
  requestAnimationFrame(loop);
}

// ============================================================
// MAIN LOOP
// ============================================================
function loop(ts) {
  requestAnimationFrame(loop);

  if (!lastTime) { lastTime = ts; return; }
  const realDt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;

  if (!running) {
    if (craneRenderer) {
      craneRenderer.update(pendulum.state, mixer.pwm, params.windSpeed, params.windDir, params.L);
    }
    return;
  }

  simAccum += realDt;

  while (simAccum >= SIM_DT) {
    simAccum -= SIM_DT;
    tick(SIM_DT);
  }

  if (craneRenderer) {
    craneRenderer.update(pendulum.state, mixer.pwm, params.windSpeed, params.windDir, params.L);
  }

  updateTelemetry();
  updateTopView();
  updateGraph();
}

// ============================================================
// PHYSICS TICK
// ============================================================
function tick(dt) {
  // Yaw drift
  yaw += (Math.random() - 0.5) * 0.02 * dt / SIM_DT;

  // Wind force (impulse / gust)
  let ws = params.windSpeed;

  if (impulseTimer > 0) {
    ws *= 3;
    impulseTimer -= dt;
  }

  if (gustMode) {
    gustTimer -= dt;
    if (gustTimer <= 0) {
      gustTimer = 1 + Math.random() * 2;
      gustMagnitude = (Math.random() - 0.5) * 0.6;
    }
    ws *= (1 + gustMagnitude);
  }

  const wRad = (params.windDir * Math.PI) / 180;
  const F_wind_x = ws * Math.sin(wRad);
  const F_wind_y = ws * Math.cos(wRad);

  // PID
  let F_prop_x = 0, F_prop_y = 0;
  if (pidEnabled) {
    const error_x = pendulum.state.theta_x;
    const error_y = pendulum.state.theta_y;
    const Fx = pidX.compute(error_x, dt);
    const Fy = pidY.compute(error_y, dt);

    mixer.mix(Fx, Fy, yaw);

    const forceScale = 1.0 / mixer.scale;
    const pwmForce = mixer.getForce(yaw);
    F_prop_x = pwmForce.Fx * forceScale;
    F_prop_y = pwmForce.Fy * forceScale;
  } else {
    mixer.mix(0, 0, yaw);
  }

  pendulum.step(dt, F_wind_x, F_wind_y, F_prop_x, F_prop_y);

  // Record graph data (every tick = 60fps)
  const tx = pendulum.state.theta_x * 180 / Math.PI;
  const ty = pendulum.state.theta_y * 180 / Math.PI;
  const tabs = Math.sqrt(tx*tx + ty*ty);
  graphData.tx.push(tx);
  graphData.ty.push(ty);
  graphData.tabs.push(tabs);
  if (graphData.tx.length > GRAPH_MAX) { graphData.tx.shift(); graphData.ty.shift(); graphData.tabs.shift(); }

  // Top-view trail
  tvTrail.push({ x: pendulum.state.theta_x, y: pendulum.state.theta_y });
  if (tvTrail.length > TV_TRAIL_MAX) tvTrail.shift();
}

// ============================================================
// TELEMETRY UPDATE (throttled to 10×/s via frame counter)
// ============================================================
let telemFrame = 0;
function updateTelemetry() {
  telemFrame++;
  if (telemFrame % 6 !== 0) return; // ~10×/s at 60fps

  const { theta_x, theta_y } = pendulum.state;
  const tx = theta_x * 180 / Math.PI;
  const ty = theta_y * 180 / Math.PI;
  const tabs = Math.sqrt(tx*tx + ty*ty);

  setText('t-theta-x', (tx >= 0 ? '+' : '') + tx.toFixed(1) + '°');
  setText('t-theta-y', (ty >= 0 ? '+' : '') + ty.toFixed(1) + '°');
  setText('t-theta-abs', tabs.toFixed(1) + '°');
  setText('t-yaw', ((yaw * 180 / Math.PI + 360) % 360).toFixed(0) + '°');

  // Motor PWM — bidirectional bars (teal = positive, orange = negative)
  mixer.pwm.forEach((p, i) => {
    const pct = Math.round(Math.abs(p) * 100);
    const barEl = document.getElementById(`m${i+1}-bar`);
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.style.background = p >= 0 ? '#00d4aa' : '#ff7c3a';
    }
    setText(`m${i+1}-val`, (p >= 0 ? '+' : '') + Math.round(p * 100) + '%');
  });

  // State
  const stateEl = document.getElementById('t-state');
  const badge = document.getElementById('scene-status');
  let stateText, stateClass, badgeClass;

  if (tabs > 15) {
    stateText = 'LIMIT EXCEEDED';
    stateClass = 'danger';
    badgeClass = 'status-danger';
  } else if (!pidEnabled || tabs > 8) {
    stateText = pidEnabled ? 'WARNING' : 'DRIFTING';
    stateClass = 'warn';
    badgeClass = 'status-warn';
  } else {
    stateText = pidEnabled ? 'STABILIZING' : 'DRIFTING';
    stateClass = pidEnabled ? '' : 'warn';
    badgeClass = pidEnabled ? 'status-ok' : 'status-warn';
  }

  if (stateEl) {
    stateEl.textContent = stateText;
    stateEl.className = 'telem-val telem-state' + (stateClass ? ' ' + stateClass : '');
  }

  const thetaAbsEl = document.getElementById('t-theta-abs');
  if (thetaAbsEl) {
    thetaAbsEl.className = 'telem-val' + (tabs > 15 ? ' danger' : tabs > 8 ? ' warn' : '');
  }

  if (badge) {
    badge.className = 'status-badge ' + badgeClass;
    badge.textContent = running
      ? (tabs > 15 ? 'ALARM' : tabs > 8 ? 'WARNING' : pidEnabled ? 'STABILIZING' : 'DRIFTING')
      : 'PAUSED';
  }
}

// ============================================================
// TOP-DOWN VIEW
// ============================================================
function updateTopView() {
  const canvas = document.getElementById('topview-canvas');
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

  // Inner ref circles
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

  // Trail (10s)
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
  const wRad = (params.windDir * Math.PI) / 180;
  const wLen = Math.max(5, params.windSpeed * 2.5);
  const wox = cx - Math.sin(wRad) * (wLen + 10);
  const woy = cy - Math.cos(wRad) * (wLen + 10);
  drawArrow2D(ctx, wox, woy, Math.sin(wRad), Math.cos(wRad), wLen, '#4da6ff', 1.5);
  // Wind parameters label near arrow origin
  ctx.fillStyle = '#4da6ff';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${params.windSpeed.toFixed(1)} m/s  ${params.windDir.toFixed(0)}\u00b0`, wox, woy - 6);

  // Propeller force vectors (M1–M4 / N,E,S,W) — drawn from centre
  const propAngles = [0, Math.PI/2, Math.PI, -Math.PI/2]; // M1=N, M2=E, M3=S, M4=W
  const propLabels = ['M1', 'M2', 'M3', 'M4'];
  let net_ax = 0, net_ay = 0;
  mixer.pwm.forEach((p, i) => {
    const ax = Math.sin(propAngles[i]);
    const ay = -Math.cos(propAngles[i]);
    const aLen = Math.abs(p) * 65;
    if (aLen > 1.5) {
      const col = Math.abs(p) > 0.05 ? '#00d4aa' : '#334455';
      drawArrow2D(ctx, cx, cy, ax, ay, aLen, col, 2);
    }
    net_ax += ax * p;
    net_ay += ay * p;
    // Motor label at fixed offset from edge
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(propLabels[i], cx + ax * 36, cy + ay * 36 + 3);
  });

  // Net resultant force vector (white)
  const netMag = Math.sqrt(net_ax * net_ax + net_ay * net_ay);
  const netLen = netMag * 65;
  if (netLen > 2) {
    const nd = 1 / netMag;
    drawArrow2D(ctx, cx, cy, net_ax * nd, net_ay * nd, netLen, 'rgba(255,255,255,0.6)', 2.5);
  }

  // Current load position
  const { theta_x, theta_y } = pendulum.state;
  const lx = cx + theta_x * 180 / Math.PI * SCALE;
  const ly = cy + theta_y * 180 / Math.PI * SCALE;

  const tabs = Math.sqrt(theta_x*theta_x + theta_y*theta_y) * 180 / Math.PI;
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
  ctx.fillText(`${Math.round(params.m)} kg  L:${params.L.toFixed(1)} m`, lx + 8, ly + 3);

  // Center dot
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

function drawArrow2D(ctx, ox, oy, dx, dy, len, color, lw) {
  const ex = ox + dx * len;
  const ey = oy + dy * len;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ex, ey);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  // Arrowhead
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 6*Math.cos(angle-0.4), ey - 6*Math.sin(angle-0.4));
  ctx.lineTo(ex - 6*Math.cos(angle+0.4), ey - 6*Math.sin(angle+0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ============================================================
// REAL-TIME GRAPH
// ============================================================
function updateGraph() {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PAD_L = 32, PAD_R = 8, PAD_T = 8, PAD_B = 20;
  const gW = W - PAD_L - PAD_R;
  const gH = H - PAD_T - PAD_B;
  const MAX_Y = 20;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  [-15, -10, -5, 0, 5, 10, 15].forEach(v => {
    const y = PAD_T + gH * (1 - (v + MAX_Y) / (2 * MAX_Y));
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + gW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(v + '°', PAD_L - 3, y + 3);
  });

  // ±15° red lines
  [-15, 15].forEach(v => {
    const y = PAD_T + gH * (1 - (v + MAX_Y) / (2 * MAX_Y));
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + gW, y);
    ctx.strokeStyle = 'rgba(255, 68, 68, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // Zero line
  const zy = PAD_T + gH * 0.5;
  ctx.beginPath(); ctx.moveTo(PAD_L, zy); ctx.lineTo(PAD_L + gW, zy);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw series
  const drawSeries = (data, color, lw) => {
    if (data.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    const n = data.length;
    const step = gW / GRAPH_MAX;
    data.forEach((v, i) => {
      const x = PAD_L + (gW - (n - 1 - i) * step);
      const y = PAD_T + gH * (1 - (v + MAX_Y) / (2 * MAX_Y));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawSeries(graphData.tx, '#4da6ff', 1.2);
  drawSeries(graphData.ty, '#ff9d00', 1.2);
  drawSeries(graphData.tabs, 'rgba(200,200,200,0.8)', 1.8);

  // Legend
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  [['θx', '#4da6ff'], ['θy', '#ff9d00'], ['|θ|', 'rgba(200,200,200,0.8)']].forEach(([label, color], i) => {
    ctx.fillStyle = color;
    ctx.fillText(label, PAD_L + i * 36 + 2, H - 5);
  });

  // Time axis ticks
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  for (let t = 0; t <= 30; t += 5) {
    const x = PAD_L + (t / 30) * gW;
    ctx.fillText('-' + (30 - t) + 's', x, H - 5);
  }
}

// ============================================================
// PID SLIDER BOUNDS
// ============================================================
function updatePIDSliderBounds(L, m) {
  const r = computePhysicsRanges(L, m);

  const slKp = document.getElementById('sl-kp');
  const slKd = document.getElementById('sl-kd');
  const slKi = document.getElementById('sl-ki');

  if (slKp) {
    slKp.max  = r.Kp.max;
    slKp.step = r.Kp.step;
    if (parseFloat(slKp.value) > r.Kp.max) {
      slKp.value = r.Kp.default;
      const valEl = document.getElementById('val-kp');
      if (valEl) valEl.textContent = r.Kp.default.toFixed(1);
      params.Kp = r.Kp.default;
      pidX.Kp = pidY.Kp = r.Kp.default;
    }
  }

  if (slKd) {
    slKd.max  = r.Kd.max;
    slKd.step = r.Kd.step;
    if (parseFloat(slKd.value) > r.Kd.max) {
      slKd.value = r.Kd.default;
      const valEl = document.getElementById('val-kd');
      if (valEl) valEl.textContent = r.Kd.default.toFixed(1);
      params.Kd = r.Kd.default;
      pidX.Kd = pidY.Kd = r.Kd.default;
    }
  }

  if (slKi) {
    slKi.max = r.Ki.max;
  }
}

window.addEventListener('pid-bounds-update', (e) => {
  updatePIDSliderBounds(e.detail.L, e.detail.m);
});

// ============================================================
// UI BINDING
// ============================================================
function bindControls() {
  // Sliders
  bindSlider('sl-wind-speed', 'val-wind-speed', v => { params.windSpeed = v; return v.toFixed(1) + ' m/s'; });
  bindSlider('sl-wind-dir',   'val-wind-dir',   v => { params.windDir = v;  return v.toFixed(0) + '°'; });
  document.getElementById('sl-rope')?.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    params.L = v;
    pendulum.L = v;
    document.getElementById('val-rope').textContent = v.toFixed(1) + ' m';
    updatePIDSliderBounds(params.L, params.m);
  });
  document.getElementById('sl-mass')?.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    params.m = v;
    pendulum.m = v;
    document.getElementById('val-mass').textContent = v.toFixed(0) + ' kg';
    updatePIDSliderBounds(params.L, params.m);
  });
  bindSlider('sl-kp',         'val-kp',         v => { params.Kp = v; pidX.Kp = v; pidY.Kp = v; return v.toFixed(1); });
  bindSlider('sl-ki',         'val-ki',         v => { params.Ki = v; pidX.Ki = v; pidY.Ki = v; return v.toFixed(2); });
  bindSlider('sl-kd',         'val-kd',         v => { params.Kd = v; pidX.Kd = v; pidY.Kd = v; return v.toFixed(1); });

  // Play/Pause
  document.getElementById('btn-play').addEventListener('click', () => {
    running = !running;
    const btn = document.getElementById('btn-play');
    btn.textContent = running ? '⏸ PAUSE' : '▶ START';
    btn.classList.toggle('running', running);
    if (running) {
      lastTime = null;
      simAccum = 0;
    }
    const badge = document.getElementById('scene-status');
    if (badge && !running) {
      badge.className = 'status-badge status-paused';
      badge.textContent = 'PAUSED';
    }
  });

  // Reset
  document.getElementById('btn-reset').addEventListener('click', () => {
    pendulum.reset();
    pidX.reset();
    pidY.reset();
    mixer.reset();
    yaw = 0;
    impulseTimer = 0;
    gustTimer = 0;
    gustMagnitude = 0;
    graphData.tx.length = 0;
    graphData.ty.length = 0;
    graphData.tabs.length = 0;
    tvTrail.length = 0;
    if (craneRenderer) craneRenderer.resetTrail();
  });

  // PID toggle
  const btnPid = document.getElementById('btn-pid');
  btnPid.addEventListener('click', () => {
    pidEnabled = !pidEnabled;
    btnPid.dataset.active = pidEnabled;
    btnPid.textContent = 'STABILIZER: ' + (pidEnabled ? 'ON' : 'OFF');
    if (pidEnabled) { pidX.reset(); pidY.reset(); }
  });

  // Wind impulse
  document.getElementById('btn-impulse').addEventListener('click', () => {
    impulseTimer = 1.0;
  });

  // Gust toggle
  const btnGust = document.getElementById('btn-gust');
  btnGust.addEventListener('click', () => {
    gustMode = !gustMode;
    btnGust.dataset.active = gustMode;
    btnGust.classList.toggle('warn-active', gustMode);
    if (!gustMode) { gustMagnitude = 0; gustTimer = 0; }
  });

  // Theme toggle
  const btnTheme = document.getElementById('btn-theme');
  let isDark = true;

  btnTheme.addEventListener('click', () => {
    isDark = !isDark;
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    btnTheme.textContent = isDark ? '☀ LIGHT' : '☾ DARK';
    if (craneRenderer) craneRenderer.setTheme(isDark);
  });
}

function bindSlider(sliderId, valId, onChange) {
  const slider = document.getElementById(sliderId);
  const valEl = document.getElementById(valId);
  if (!slider || !valEl) return;
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valEl.textContent = onChange(v);
  });
}

// ---- DOM helpers ----
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStyle(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = val;
}

// ============================================================
// START
// ============================================================
waitForThree();
