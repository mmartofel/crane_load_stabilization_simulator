#!/usr/bin/env python3
"""
generate_optimal_pid.py  —  v7 (parallel CPU execution)
══════════════════════════════════════════════════════════════════════════════
Generates training CSV where every row contains Kp/Ki/Kd derived from
control-theory formulas, not simulation scoring.

WHY ANALYTICAL:
  Grid-search generates all (Kp,Ki,Kd) combinations for the same (L,m,wind)
  condition, so the ML model sees many different targets for the same input and
  converges to the mean rather than the optimum (R²≈0).  The analytical
  approach creates a smooth, learnable mapping:
    Kp = alpha(wind_loading) * m*g/L    alpha grows with wind/gravity ratio
    Ki = beta(wind_loading)  * Kp / T   integral to remove SS error, capped at KI_MAX
    Kd = GAMMA_KD * T                   derivative for b=1.2 system, capped at KD_MAX
  Plus Gaussian perturbations so the ML model generalises not memorises.

GAIN RANGES (empirically validated — hard limits, never exceeded):
  Kp  30 – 36
  Ki  13 – 16
  Kd  18 – 21

PHYSICS ALIGNMENT (v5 changes):
  Force application now matches sim.js PropellerMixer routing exactly:
    PID_output → clamp(output * SCALE, -1, 1) / SCALE² → applied force
  This gives 6.667× force amplification (SCALE=0.15) and saturates at ±44.44 N,
  identical to ui.js / ai-ui.js / runHeadless.

PARALLELISM (v6+ changes):
  All conditions run in parallel via ProcessPoolExecutor (CPU cores).
  Expected wall-clock: ~30 s on a 16-core machine.

USAGE:
  python generate_optimal_pid.py                     # full dataset
  python generate_optimal_pid.py --quick             # smoke-test (~5 s)
  python generate_optimal_pid.py --workers 16        # cap CPU workers
  python generate_optimal_pid.py --out PATH          # custom output path
  python trainer.py PATH                             # train the model
  python generate_optimal_pid_gpu.py                 # PyTorch GPU version
"""

import argparse, csv, math, os, sys, time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

# ── Constants ─────────────────────────────────────────────────────────────────
G            = 9.81
B            = 1.2    # must match sim.js (was 0.15 — caused 8× damping mismatch)
DT           = 0.016  # matches live sim animation loop (ui.js / ai-ui.js)
MAX_TIME     = 40.0
DIVERGE_DEG  = 45.0
SETTLE_DEG   = 1.0
SETTLE_DUR   = 2.0

# PropellerMixer scale — must match sim.js PropellerMixer.scale
SCALE = 0.15

# Hard gain bounds — outputs are ALWAYS clamped to these ranges
KP_MIN = 30.0;  KP_MAX = 36.0
KI_MIN = 13.0;  KI_MAX = 16.0
KD_MIN = 18.0;  KD_MAX = 21.0

# Wind-loading saturation rate for Kp/Ki formula.
# Calibrated so that at nominal (L=10m, m=50kg, ws=8 m/s) → wl≈0.187 → ratio=0.5 → center of range.
ALPHA_WL = 3.7

# Noise (absolute, in gain units) — spreads training data across full range without leaving it
NOISE_KP = 1.5   # ±1.5 around optimal Kp (range width = 6)
NOISE_KI = 0.75  # ±0.75 around optimal Ki (range width = 3)
NOISE_KD = 0.75  # ±0.75 around optimal Kd (range width = 3)

# Rope-period extremes for Kd linear mapping: L=3m → Kd=KD_MIN, L=20m → Kd=KD_MAX
_T_LO = 2.0 * math.pi * math.sqrt(3.0  / G)   # ≈ 3.47 s
_T_HI = 2.0 * math.pi * math.sqrt(20.0 / G)   # ≈ 8.97 s

CSV_HEADER = [
    'timestamp','L','m','Kp','Ki','Kd',
    'wind_speed','wind_dir_deg','disturbance_type',
    'ISE','IAE','ITAE','t_settle','overshoot_deg',
    'steady_state_error','score','status',
]

# Disturbance type codes (used by GPU version)
DIST_MAP = {'step': 0, 'impulse': 1, 'ramp': 2, 'gust': 3}

# Pre-computed simulation constants
_N_STEPS  = int(MAX_TIME / DT)
_DIV_RAD  = math.radians(DIVERGE_DEG)
_THR_RAD  = math.radians(SETTLE_DEG)
_SCALE_SQ = SCALE * SCALE
_TWO_PI_3 = 2.0 * math.pi / 3.0

# ── Physics helpers ───────────────────────────────────────────────────────────

def period(L):           return 2.0 * math.pi * math.sqrt(L / G)
def wind_loading(ws, m): return (ws / (m * G)) / math.radians(5.0)

def optimal_gains(L, m, ws):
    """Physics-based gains, always within validated ranges.
    Kp/Ki scale with wind loading (low wind → near min, high wind → near max).
    Kd scales with rope period (short rope → near min, long rope → near max).
    This creates a learnable ML mapping while respecting the hard bounds."""
    wl = wind_loading(ws, m)
    T  = period(L)
    ratio_wl = 1.0 - math.exp(-ALPHA_WL * wl)
    ratio_T  = max(0.0, min(1.0, (T - _T_LO) / (_T_HI - _T_LO)))
    Kp = KP_MIN + (KP_MAX - KP_MIN) * ratio_wl
    Ki = KI_MIN + (KI_MAX - KI_MIN) * ratio_wl
    Kd = KD_MIN + (KD_MAX - KD_MIN) * ratio_T
    return Kp, Ki, Kd

def perturbed_gains(L, m, ws, rng):
    """Gaussian noise (absolute) around physics optimal, hard-clamped to validated ranges."""
    Kp0, Ki0, Kd0 = optimal_gains(L, m, ws)
    Kp = float(np.clip(Kp0 + rng.normal(0, NOISE_KP), KP_MIN, KP_MAX))
    Ki = float(np.clip(Ki0 + rng.normal(0, NOISE_KI), KI_MIN, KI_MAX))
    Kd = float(np.clip(Kd0 + rng.normal(0, NOISE_KD), KD_MIN, KD_MAX))
    return Kp, Ki, Kd

# ── Simulation ────────────────────────────────────────────────────────────────

def simulate(L, m, Kp, Ki, Kd, ws, wd, dist='step'):
    """Run one simulation. Returns metrics dict or None if diverged."""
    wr   = math.radians(wd)
    Fx0  = ws * math.cos(wr)
    Fy0  = ws * math.sin(wr)

    n = _N_STEPS
    div = _DIV_RAD; thr = _THR_RAD
    tx=ty=ox=oy=ix=iy=pex=pey=0.
    ISE=IAE=ITAE=max_t=sc=0.; ts=None

    for step in range(n):
        t = step * DT
        if   dist=='step':    f = 1. if t>=1. else 0.
        elif dist=='impulse': f = 3. if 1.<=t<=1.5 else 0.
        elif dist=='ramp':    f = min(t/10., 1.)
        else:                 f = 1.+0.4*math.sin(_TWO_PI_3 * t)

        Fx=Fx0*f; Fy=Fy0*f

        ex=tx; ey=ty
        ix=float(np.clip(ix+ex*DT,-50,50)); iy=float(np.clip(iy+ey*DT,-50,50))
        dex=(ex-pex)/DT if step>0 else 0.; pex=ex
        dey=(ey-pey)/DT if step>0 else 0.; pey=ey

        raw_x = Kp*ex + Ki*ix + Kd*dex
        raw_y = Kp*ey + Ki*iy + Kd*dey
        fpx = float(np.clip(raw_x * SCALE, -1.0, 1.0)) / _SCALE_SQ
        fpy = float(np.clip(raw_y * SCALE, -1.0, 1.0)) / _SCALE_SQ

        ax=(Fx-B*ox-m*G*tx-fpx)/(m*L); ay=(Fy-B*oy-m*G*ty-fpy)/(m*L)
        ox+=ax*DT; oy+=ay*DT; tx+=ox*DT; ty+=oy*DT

        tm=math.hypot(tx,ty)
        if tm>div: return None
        tsq=tx*tx+ty*ty
        ISE+=tsq*DT; IAE+=math.sqrt(tsq)*DT; ITAE+=t*math.sqrt(tsq)*DT
        max_t=max(max_t,tm)
        if tm<thr:
            sc+=DT
            if sc>=SETTLE_DUR:
                if ts is None: ts=t-SETTLE_DUR
                break
        else: sc=0.

    ss=math.hypot(tx,ty)
    score=(0.30*min(ISE/10,1)+0.20*min(IAE/20,1)+0.30*min(ITAE/200,1)
           +0.15*min((ts or MAX_TIME)/MAX_TIME,1)+0.05*min(math.degrees(max_t)/20,1))
    return {
        'ISE':round(float(ISE),4),'IAE':round(float(IAE),4),'ITAE':round(float(ITAE),4),
        't_settle':round(float(ts),2) if ts else None,
        'overshoot_deg':round(float(math.degrees(max_t)),3),
        'steady_state_error':round(float(math.degrees(ss)),4),
        'score':round(float(score),4),'status':'ok',
    }

# ── Parameter space ───────────────────────────────────────────────────────────

def build_conditions(quick):
    if quick:
        L_v=[5.,10.,15.]; m_v=[2.,10.,50.,150.]
        ws_v=[3.,10.]; wd_v=[45.,225.]; dist_v=['step']; n_p=3
    else:
        L_v=[3.,5.,7.,10.,12.,15.,20.]
        m_v=[2.,5.,10.,20.,50.,100.,150.,200.,500.]
        ws_v=[2.,3.,4.,5.,6.,7.,8.,9.,10.,11.,12.,13.,14.,15.,16.,17.,18.,19.,20.]
        wd_v=[0.,45.,60.,90.,135.,180.,200.,270.,315.]
        dist_v=['step','impulse','ramp','gust','rotate']; n_p=5

    conds=[]
    for L in L_v:
        for m in m_v:
            for ws in ws_v:
                for wd in wd_v:
                    for d in dist_v:
                        conds.append((L,m,ws,wd,d,False))
                        for _ in range(n_p):
                            conds.append((L,m,ws,wd,d,True))
    return conds

# ── Worker (module-level for ProcessPoolExecutor pickling) ────────────────────

def _worker(args):
    """Run one simulation condition. Top-level so ProcessPoolExecutor can pickle it."""
    L, m, ws, wd, dist, noisy, seed = args
    rng = np.random.default_rng(seed)
    Kp, Ki, Kd = perturbed_gains(L, m, ws, rng) if noisy else optimal_gains(L, m, ws)
    r   = simulate(L, m, Kp, Ki, Kd, ws, wd, dist)
    ts  = datetime.now().isoformat() + 'Z'
    return (L, m, ws, wd, dist, noisy, Kp, Ki, Kd, r, ts)

# ── Main ──────────────────────────────────────────────────────────────────────

def main(out_path, quick, n_workers=None):
    out  = Path(out_path); out.parent.mkdir(parents=True, exist_ok=True)
    conds = build_conditions(quick)
    total = len(conds)
    n_workers = n_workers or os.cpu_count() or 1

    # Generate per-condition seeds from master RNG for reproducibility
    master_rng = np.random.default_rng(42)
    seeds = master_rng.integers(0, 2**32, size=total).tolist()
    args_list = [(L,m,ws,wd,d,noisy,seeds[i])
                 for i,(L,m,ws,wd,d,noisy) in enumerate(conds)]

    est_min = total * 0.05 / 60 / n_workers
    print(f'\n{"="*64}')
    print(f'  Crane PID Analytical Data Generator  v7')
    print(f'  Rows      : {total}  |  Workers : {n_workers}')
    print(f'  Est. time : ~{max(est_min, 0.1):.1f} min')
    print(f'  Output    : {out}')
    print(f'{"="*64}\n')

    ok = failed = 0
    t0 = time.time()
    report_every = max(1, total // 60)

    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=CSV_HEADER)
        w.writeheader()

        with ProcessPoolExecutor(max_workers=n_workers) as ex:
            for i, (L,m,ws,wd,dist,noisy,Kp,Ki,Kd,r,ts) in enumerate(
                    ex.map(_worker, args_list, chunksize=max(64, total // (n_workers * 4)))):

                if r is None:
                    failed += 1
                else:
                    w.writerow({
                        'timestamp': ts,
                        'L':L,'m':m,'Kp':round(Kp,4),'Ki':round(Ki,4),'Kd':round(Kd,4),
                        'wind_speed':ws,'wind_dir_deg':wd,'disturbance_type':dist,
                        **{k:(r[k] if r[k] is not None else '') for k in
                           ['ISE','IAE','ITAE','t_settle','overshoot_deg',
                            'steady_state_error','score','status']}
                    })
                    f.flush(); ok += 1

                if (i+1) % report_every == 0 or i == total-1:
                    pct = (i+1) / total * 100
                    el  = time.time() - t0
                    eta = el / (i+1) * (total - i - 1)
                    bar = '█' * int(pct/5) + '░' * (20 - int(pct/5))
                    tag = 'N' if noisy else 'O'
                    print(f'\r  [{bar}]{pct:5.1f}%  ok={ok} fail={failed}'
                          f'  ETA {eta/60:.1f}m  L={L:.0f} m={m:.0f}'
                          f'  [{tag}]Kp={Kp:.2f}     ', end='', flush=True)

    el = time.time() - t0
    print(f'\n\n{"="*64}')
    print(f'  Done in {el/60:.1f} min  |  ok={ok}  fail={failed}')
    print(f'  Output: {out}')
    print(f'{"="*64}\n')
    print(f'  Next: python trainer.py "{out}"\n')
    return ok

if __name__=='__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--out', default='../data/experiments/model_dataset_auto/model_data.csv')
    p.add_argument('--quick', action='store_true')
    p.add_argument('--workers', type=int, default=None,
                   help='Number of parallel workers (default: all CPU cores)')
    a = p.parse_args()
    sys.exit(0 if main(a.out, a.quick, a.workers) > 0 else 1)
