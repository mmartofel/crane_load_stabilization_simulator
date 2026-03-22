# data/ — PID Test Results

This directory stores persistent data for the Tower Crane Load Stabilization Simulator.

| File / Directory | Description |
|---|---|
| `test_results.csv` | PID optimizer test results — one row per completed simulation run |
| `model_meta.json` | AI model metadata (R², training row count, last-trained timestamp) |
| `ai_sessions/` | JSON files for completed AI DRIVEN scenario sessions (used by the Reports tab) |

---

## test_results.csv

`test_results.csv` is appended by the server every time the **PID TESTS** tab saves a batch of optimizer results (`POST /api/results`). The same file is read by the `ai-service` Python process as training data for the GradientBoosting ML model.

### Column reference

| Column | Type | Unit | Range | Description |
|---|---|---|---|---|
| `timestamp` | string | — | ISO 8601 UTC | Date and time the test ran, e.g. `2026-03-20T22:40:38.911Z` |
| `L` | float | meters | 3 – 20 | Rope / cable length (pendulum length) |
| `m` | float | kg | 10 – 500 | Load (cargo) mass |
| `Kp` | float | dimensionless | ~0.04·m – 0.85·m | PID proportional gain |
| `Ki` | float | 1/s | 0.01 – 0.40 | PID integral gain |
| `Kd` | float | s | ~0.05·T – 1.4·T† | PID derivative gain |
| `wind_speed` | float | m/s | 0 – 20 | Steady-state wind speed magnitude |
| `wind_dir_deg` | float | degrees | 0 – 360 | Wind direction (0° = +X axis, 90° = +Y axis) |
| `disturbance_type` | string | — | see below | How wind force is applied during the test |
| `ISE` | float | rad²·s | ≥ 0 | Integral of Squared Error — heavily penalises large angle excursions |
| `IAE` | float | rad·s | ≥ 0 | Integral of Absolute Error — equal weight to all deviations |
| `ITAE` | float | rad·s² | ≥ 0 | Integral of Time×Absolute Error — penalises errors that persist late in the run |
| `t_settle` | float or `null` | s | 0 – 60 or `null` | Time at which \|θ\| first dropped and stayed below 1° for ≥ 2 s; `null` if the load never settled within the 60 s simulation window |
| `overshoot_deg` | float | degrees | 0 – 45 | Peak load deflection angle \|θ\| reached during the entire run |
| `steady_state_error` | float | degrees | ≥ 0 | Mean \|θ\| over the final 5 s of the simulation — residual offset after transient has passed |
| `score` | float | dimensionless | 0 – 1 | Composite weighted performance score (lower = better); see formula below |
| `status` | string | — | see below | Outcome of the simulation run |

† T = 2π√(L / g), the natural pendulum period, where g = 9.81 m/s².

---

### `disturbance_type` values

| Value | Description |
|---|---|
| `step` | Wind is applied at t = 1 s and held constant for the rest of the run — standard step-response test |
| `impulse` | A 3× wind burst is applied from t = 1 s to t = 1.5 s, then drops to zero — tests rejection of a short sharp disturbance |
| `ramp` | Wind magnitude ramps linearly from 0 to full over 10 s — tests tracking of a slowly increasing load |
| `gust` | Wind magnitude is modulated randomly (±80% of set value) at each timestep — tests robustness to turbulent / gusty conditions |

---

### `status` values

| Value | Description |
|---|---|
| `ok` | Simulation completed normally; load either settled or reached the 60 s timeout without diverging |
| `diverged` | Load angle exceeded 45° — the controller lost control and the run was aborted early |
| `timeout` | Simulation ran the full 60 s without the load settling to < 1° |

---

### Composite score formula

The `score` column is a weighted sum of five normalised performance metrics (lower is better):

```
Score = 0.30 · ISE_norm  +  0.20 · IAE_norm  +  0.30 · ITAE_norm
      + 0.15 · Ts_norm   +  0.05 · OS_norm

where:
  ISE_norm  = min(ISE   /   5,  1)
  IAE_norm  = min(IAE   /  10,  1)
  ITAE_norm = min(ITAE  / 100,  1)
  Ts_norm   = min(t_settle / 30, 1)   — uses 30 s if t_settle is null
  OS_norm   = min(overshoot_deg / 20, 1)
```

Each component is clamped to [0, 1] before weighting. A perfect score of 0 would require zero error and instantaneous settling with no overshoot.

---

### Example row

```
timestamp,              L,  m,  Kp,   Ki,    Kd, wind_speed, wind_dir_deg, disturbance_type,  ISE,    IAE,     ITAE,  t_settle, overshoot_deg, steady_state_error, score, status
2026-03-20T22:40:38.911Z, 10, 50,  2, 0.01,  0.32,          8,         45.0,             step, 0.0207, 0.9272, 28.0971,      0.00,          1.81,             0.7255, 0.1086,     ok
```

Interpretation: rope 10 m, load 50 kg, PID (2 / 0.01 / 0.32), 8 m/s wind from 45°, step disturbance. The load settled immediately (t_settle = 0.00 s), peaked at 1.81°, and had a small residual of 0.73°. Composite score 0.1086 (low = good).
