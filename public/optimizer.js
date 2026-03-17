// ============================================================
// optimizer.js — PID batch testing, Ziegler-Nichols, scoring
// ============================================================

import { Pendulum, PIDController, PropellerMixer } from './sim.js';

export class TestScenario {
  constructor({ L, m, Kp, Ki, Kd, wind_speed = 8, wind_dir = Math.PI / 4,
                disturbance_type = 'step', max_time_s = 60, dt = 0.005 }) {
    this.L = L;
    this.m = m;
    this.Kp = Kp;
    this.Ki = Ki;
    this.Kd = Kd;
    this.wind_speed = wind_speed;
    this.wind_dir = wind_dir;
    this.disturbance_type = disturbance_type;
    this.max_time_s = max_time_s;
    this.dt = dt;
  }
}

export class TestResult {
  constructor() {
    this.scenario = null;
    this.timestamp = null;
    this.metrics = {
      ISE: 0, IAE: 0, ITAE: 0,
      t_settle: null, overshoot_deg: 0,
      steady_state_error: 0, score: 0
    };
    this.time_series = [];
    this.status = 'ok';
  }
}

export function computeScore(metrics, weights = {
  w_ISE: 0.3, w_IAE: 0.2, w_ITAE: 0.3, w_settle: 0.15, w_overshoot: 0.05
}) {
  const ISE_MAX = 500, IAE_MAX = 100, ITAE_MAX = 3000, SETTLE_MAX = 60, OS_MAX = 30;
  const settle = metrics.t_settle ?? SETTLE_MAX;
  return (
    weights.w_ISE      * Math.min(metrics.ISE / ISE_MAX, 1) +
    weights.w_IAE      * Math.min(metrics.IAE / IAE_MAX, 1) +
    weights.w_ITAE     * Math.min(metrics.ITAE / ITAE_MAX, 1) +
    weights.w_settle   * Math.min(settle / SETTLE_MAX, 1) +
    weights.w_overshoot * Math.min(metrics.overshoot_deg / OS_MAX, 1)
  );
}

export class BatchOptimizer {
  constructor() {
    this._worker = null;
    this._cancelled = false;
  }

  cancel() {
    this._cancelled = true;
    if (this._worker) { this._worker.terminate(); this._worker = null; }
  }

  runSingleTest(scenario) {
    const result = Pendulum.runHeadless(scenario);
    result.metrics.score = computeScore(result.metrics);
    return result;
  }

  async runGridSearch({
    Kp_range, Ki_range, Kd_range,
    L_values, m_values, disturbance_types,
    wind_speed = 8,
    onProgress, onComplete
  }) {
    this._cancelled = false;

    // Build scenario list
    const scenarios = [];
    for (const L of L_values) {
      for (const m of m_values) {
        for (const dist of disturbance_types) {
          for (const Kp of Kp_range) {
            for (const Ki of Ki_range) {
              for (const Kd of Kd_range) {
                scenarios.push(new TestScenario({
                  L, m, Kp, Ki, Kd, wind_speed,
                  wind_dir: Math.PI / 4, disturbance_type: dist
                }));
              }
            }
          }
        }
      }
    }

    const total = scenarios.length;

    // Use Web Worker for large batches
    if (total > 500 && typeof Worker !== 'undefined') {
      return this._runWithWorker(scenarios, onProgress, onComplete);
    }

    // Main-thread batched execution
    const results = [];
    const BATCH = 10;
    for (let i = 0; i < scenarios.length; i++) {
      if (this._cancelled) break;
      const result = this.runSingleTest(scenarios[i]);
      results.push(result);
      if (onProgress) onProgress({ done: i + 1, total, result });
      if ((i + 1) % BATCH === 0) {
        await new Promise(r => setTimeout(r, 0)); // yield to UI
      }
    }

    if (onComplete) onComplete(results);
    return results;
  }

  _runWithWorker(scenarios, onProgress, onComplete) {
    return new Promise((resolve) => {
      this._worker = new Worker('optimizer-worker.js');
      const results = [];

      this._worker.onmessage = (e) => {
        if (e.data.type === 'PROGRESS') {
          results.push(e.data.result);
          if (onProgress) onProgress({ done: e.data.done, total: e.data.total, result: e.data.result });
        } else if (e.data.type === 'COMPLETE') {
          this._worker.terminate();
          this._worker = null;
          if (onComplete) onComplete(e.data.results);
          resolve(e.data.results);
        }
      };

      this._worker.onerror = (err) => {
        console.error('Worker error:', err);
        this._worker.terminate();
        this._worker = null;
        // Fallback to main thread
        resolve([]);
      };

      this._worker.postMessage({ type: 'START', scenarios });
    });
  }

  async runZieglerNichols({ L, m, wind_speed = 8 }) {
    // Find ultimate gain Ku: Ki=Kd=0, binary search for oscillation
    let Kp_lo = 0.1, Kp_hi = 100;
    let Ku = null;

    for (let iter = 0; iter < 20; iter++) {
      const Kp = (Kp_lo + Kp_hi) / 2;
      const scenario = new TestScenario({
        L, m, Kp, Ki: 0, Kd: 0,
        wind_speed, wind_dir: Math.PI / 4,
        disturbance_type: 'step', max_time_s: 30, dt: 0.005
      });
      const result = Pendulum.runHeadless(scenario);

      if (result.status === 'diverged' || result.metrics.overshoot_deg > 10) {
        Kp_hi = Kp;
      } else {
        Kp_lo = Kp;
        Ku = Kp;
      }
    }

    if (!Ku) Ku = Kp_lo;

    // Estimate Tu from oscillation period in time series
    // Run at Ku and measure zero crossings
    const tuScenario = new TestScenario({
      L, m, Kp: Ku, Ki: 0, Kd: 0,
      wind_speed, wind_dir: Math.PI / 4,
      disturbance_type: 'step', max_time_s: 20, dt: 0.005
    });
    const tuResult = Pendulum.runHeadless(tuScenario);

    // Find oscillation period from zero crossings of theta_mag derivative
    let Tu = 4.0; // default fallback
    const ts = tuResult.time_series;
    if (ts.length > 4) {
      const peaks = [];
      for (let i = 1; i < ts.length - 1; i++) {
        if (ts[i].theta_mag > ts[i-1].theta_mag && ts[i].theta_mag > ts[i+1].theta_mag) {
          peaks.push(ts[i].t);
        }
      }
      if (peaks.length >= 2) {
        const periods = [];
        for (let i = 1; i < peaks.length; i++) periods.push(peaks[i] - peaks[i-1]);
        Tu = periods.reduce((a, b) => a + b, 0) / periods.length;
      }
    }

    // Ziegler-Nichols PID formula
    const Kp = 0.6 * Ku;
    const Ki = 2 * Kp / Tu;
    const Kd = Kp * Tu / 8;

    return { Ku, Tu, Kp, Ki, Kd };
  }

  getBestParams(results, topN = 5) {
    const groups = {};
    results.forEach(r => {
      const key = `L${r.scenario.L}_m${r.scenario.m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });
    const best = {};
    Object.entries(groups).forEach(([k, arr]) => {
      best[k] = arr
        .filter(r => r.status !== 'diverged')
        .sort((a, b) => a.metrics.score - b.metrics.score)
        .slice(0, topN);
    });
    return best;
  }
}
