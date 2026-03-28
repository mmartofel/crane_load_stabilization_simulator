## AI Service — Training Data & Model Guide

### Recommended workflow

```bash
cd ai-service

# 1. Generate training data (analytical approach — fastest path to working model)
python generate_optimal_pid.py --quick   # smoke test: ~20 s, ~200 rows
python generate_optimal_pid.py           # full:       ~5 min, ~1500 rows

# 2. Train the model
python trainer.py ../data/experiments/model_dataset_auto/model_data.csv

# 3. Start the AI service
python main.py
```

Then activate the experiment from the DATA GENERATOR tab in the web UI.

---

### Expected R² vs actual stabilization performance

| Scenario | R² | Avg θ | Max θ | Note |
|----------|----|-------|-------|------|
| Analytical generator (B=1.2, Kd>0) | > 0.85 | < 1° | < 5° | **Target** |
| Analytical generator (B=0.15 — wrong) | ~0.99 | 1–5° | 20–50° | High R² but bad physics |
| Grid search, all combinations | ~0.01 | uncontrolled | 50–100° | ML-ambiguous data |
| Analytical fallback (no model) | N/A | ~0.02° | ~6° | Works because formula matches sim |

High R² does NOT guarantee good stabilization if training physics differ from `sim.js`.

---

### Critical physics constants — must match sim.js

| Constant | `sim.js` value | `generate_optimal_pid.py` | `data-generator-ui.js` |
|----------|---------------|--------------------------|----------------------|
| Damping `b` | **1.2** | `B = 1.2` | `b: 1.2` |
| Gravity `g` | 9.81 | `G = 9.81` | `const g = 9.81` |
| dt | 0.016 s | `DT = 0.016` | passed in config |
| Diverge threshold | 45° | `DIVERGE_DEG = 45` | hardcoded 45° |

If damping is set to 0.15 (old default), gains are calibrated for a lightly-damped system and will cause oscillation in the real simulator (b=1.2), even if R² appears very high.

---

### Analytical gain formula (generate_optimal_pid.py)

```
Kp = alpha(wind_loading) * m*g/L      alpha: 0.30–0.55 (sigmoid of wind/gravity ratio)
Ki = beta(wind_loading) * Kp / T      T = 2π√(L/g)
Kd = gamma * T                        gamma ≈ 0.4  (aligned with model.py fallback)
```

With B=1.2, the system is highly damped, so:
- Kp can be lower (less restoring force needed — damping helps)
- Kd is still beneficial for transient response
- Ki remains small to remove steady-state error

---

### model.py analytical fallback (when no trained model available)

```python
Kp = min((m*g/L) * 0.55, 18)
Ki = 0.1 / max(L/10, 0.1)
Kd = T * 0.4                    # T = 2π√(L/g)
```

This fallback works well because it includes Kd and is calibrated for the real simulator behavior. Trained models should aim to match or exceed this baseline.

---

### Grid-search data — why it fails for ML training

The DATA GENERATOR generates every (Kp, Ki, Kd) combination from a grid for each (L, m, wind) condition. For a given (L=10, m=50, wind=8), the CSV may contain:

| Kp | Ki | Kd | score |
|----|----|----|-------|
| 1  | 0.01 | 0 | 0.85 (bad) |
| 15 | 0.20 | 3 | 0.12 (good) |
| 40 | 0.50 | 8 | 0.90 (bad) |

All three rows have the **same inputs** but **different targets**. The ML model converges to the mean rather than the optimal, yielding R²≈0 and no useful predictions.

**Fix:** emit only the best-scoring (Kp, Ki, Kd) per (L, m, wind, disturbance) group.
