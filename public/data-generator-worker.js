// data-generator-worker.js — headless physics engine for DATA GENERATOR tab
// Standalone file: no ES6 imports (Web Workers cannot use module imports).
// Message protocol:
//   Input:    { type: 'START', config: { L_values, m_values,
//               Kp_min, Kp_max, Kp_steps, Ki_min, Ki_max, Ki_steps,
//               Kd_min, Kd_max, Kd_steps, wind_configs, b, dt, max_time } }
//   Progress: { type: 'PROGRESS', done, total, ok, skipped, lastResult }
//   Complete: { type: 'COMPLETE', records, done, skipped }
//   Error:    { type: 'ERROR', message }

const g = 9.81;

// Generate n evenly-spaced values between min and max (inclusive)
function linspace(min, max, n) {
  if (n === 1) return [min];
  return Array.from({ length: n }, (_, i) => min + (max - min) * i / (n - 1));
}

// Run one headless pendulum simulation; returns metrics object or null if diverged
function simulatePendulum(L, m, Kp, Ki, Kd, windSpeed, windDirDeg,
                          disturbanceType, b, dt, maxTime) {
  const nSteps = Math.round(maxTime / dt);
  let thetaX = 0, thetaY = 0, omegaX = 0, omegaY = 0;
  let intX = 0, intY = 0, prevEx = 0, prevEy = 0;

  const windRad  = windDirDeg * Math.PI / 180;
  const FwBaseX  = windSpeed * Math.cos(windRad);
  const FwBaseY  = windSpeed * Math.sin(windRad);

  let ISE = 0, IAE = 0, ITAE = 0, maxTheta = 0;
  let tSettle = null, settleCounter = 0;
  const SETTLE_THRESH = 1.0 * Math.PI / 180; // 1 degree
  const SETTLE_DUR    = 2.0;                  // seconds below threshold

  for (let step = 0; step < nSteps; step++) {
    const t = step * dt;

    // Disturbance profile
    let factor;
    if      (disturbanceType === 'step')    factor = t >= 1.0 ? 1.0 : 0.0;
    else if (disturbanceType === 'impulse') factor = (t >= 1.0 && t <= 1.5) ? 3.0 : 0.0;
    else if (disturbanceType === 'ramp')    factor = Math.min(t / 10.0, 1.0);
    else                                    factor = 1.0 + 0.4 * Math.sin(2 * Math.PI * t / 3.0); // gust

    const FwX = FwBaseX * factor;
    const FwY = FwBaseY * factor;

    // PID controller
    const ex = -thetaX, ey = -thetaY;
    intX = Math.max(-10, Math.min(10, intX + ex * dt));
    intY = Math.max(-10, Math.min(10, intY + ey * dt));
    const dex = step > 0 ? (ex - prevEx) / dt : 0;
    const dey = step > 0 ? (ey - prevEy) / dt : 0;
    prevEx = ex; prevEy = ey;

    const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const FpX  = clip(Kp * ex + Ki * intX + Kd * dex, -50, 50);
    const FpY  = clip(Kp * ey + Ki * intY + Kd * dey, -50, 50);

    // Linearized spherical pendulum equations of motion
    const ax = (FwX - b * omegaX - m * g * thetaX - FpX) / (m * L);
    const ay = (FwY - b * omegaY - m * g * thetaY - FpY) / (m * L);
    omegaX += ax * dt;
    omegaY += ay * dt;
    thetaX += omegaX * dt;
    thetaY += omegaY * dt;

    const thetaMag = Math.hypot(thetaX, thetaY);
    if (thetaMag > 45 * Math.PI / 180) return null; // diverged — skip this config

    // Accumulate error metrics
    const thetaSq = thetaX * thetaX + thetaY * thetaY;
    ISE  += thetaSq * dt;
    IAE  += Math.sqrt(thetaSq) * dt;
    ITAE += t * Math.sqrt(thetaSq) * dt;
    maxTheta = Math.max(maxTheta, thetaMag);

    // Settle-time detection: must stay below threshold for SETTLE_DUR seconds
    if (thetaMag < SETTLE_THRESH) {
      settleCounter += dt;
      if (settleCounter >= SETTLE_DUR && tSettle === null)
        tSettle = t - SETTLE_DUR;
    } else {
      settleCounter = 0;
    }
  }

  const ssError = Math.hypot(thetaX, thetaY);
  const ISE_n   = Math.min(ISE   / 10.0,  1.0);
  const IAE_n   = Math.min(IAE   / 20.0,  1.0);
  const ITAE_n  = Math.min(ITAE  / 200.0, 1.0);
  const Ts_n    = Math.min((tSettle ?? maxTime) / maxTime, 1.0);
  const OS_n    = Math.min(maxTheta * 180 / Math.PI / 20.0, 1.0);
  const score   = 0.30 * ISE_n + 0.20 * IAE_n + 0.30 * ITAE_n + 0.15 * Ts_n + 0.05 * OS_n;

  return {
    ISE:                +ISE.toFixed(4),
    IAE:                +IAE.toFixed(4),
    ITAE:               +ITAE.toFixed(4),
    t_settle:           tSettle !== null ? +tSettle.toFixed(2) : null,
    overshoot_deg:      +(maxTheta * 180 / Math.PI).toFixed(3),
    steady_state_error: +(ssError * 180 / Math.PI).toFixed(4),
    score:              +score.toFixed(4),
    status:             'ok',
  };
}

self.onmessage = function(e) {
  if (e.data.type !== 'START') return;
  const cfg = e.data.config;

  try {
    const KpVals = linspace(cfg.Kp_min, cfg.Kp_max, cfg.Kp_steps);
    const KiVals = linspace(cfg.Ki_min, cfg.Ki_max, cfg.Ki_steps);
    const KdVals = linspace(cfg.Kd_min, cfg.Kd_max, cfg.Kd_steps);
    const total  = cfg.L_values.length * cfg.m_values.length *
                   KpVals.length * KiVals.length * KdVals.length *
                   cfg.wind_configs.length;

    const records = [];
    let done = 0, skipped = 0;
    // Send ~200 progress reports over the full run
    const PROGRESS_INTERVAL = Math.max(1, Math.floor(total / 200));

    for (const L of cfg.L_values) {
      for (const m of cfg.m_values) {
        for (const Kp of KpVals) {
          for (const Ki of KiVals) {
            for (const Kd of KdVals) {
              for (const wc of cfg.wind_configs) {
                const result = simulatePendulum(
                  L, m, Kp, Ki, Kd,
                  wc.speed, wc.dir_deg, wc.disturbance_type,
                  cfg.b ?? 0.15, cfg.dt ?? 0.005, cfg.max_time ?? 30.0
                );
                done++;
                if (result === null) { skipped++; continue; }

                records.push({
                  timestamp:        new Date().toISOString(),
                  L, m,
                  Kp: +Kp.toFixed(4), Ki: +Ki.toFixed(4), Kd: +Kd.toFixed(4),
                  wind_speed:       wc.speed,
                  wind_dir_deg:     wc.dir_deg,
                  disturbance_type: wc.disturbance_type,
                  ...result
                });

                if (done % PROGRESS_INTERVAL === 0) {
                  self.postMessage({
                    type: 'PROGRESS', done, total,
                    ok: records.length, skipped,
                    lastResult: {
                      L, m,
                      Kp: +Kp.toFixed(2), Ki: +Ki.toFixed(3), Kd: +Kd.toFixed(2),
                      score: result.score
                    }
                  });
                }
              }
            }
          }
        }
      }
    }

    self.postMessage({ type: 'COMPLETE', records, done, skipped });
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: err.message });
  }
};
