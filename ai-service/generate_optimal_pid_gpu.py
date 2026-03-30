#!/usr/bin/env python3
"""
generate_optimal_pid_gpu.py  —  PyTorch batched GPU version
════════════════════════════════════════════════════════════
Runs ALL simulation conditions in parallel as a single batched tensor operation
on GPU (or CPU when CUDA is not available).

HOW IT WORKS:
  Instead of simulating one condition at a time, all N conditions are stacked
  into tensors of shape (N,). The entire Euler loop runs once per timestep,
  updating all N simulations simultaneously via vectorised tensor ops.

  Early-exit is replaced by a `settled` boolean mask: once a simulation settles,
  its propeller forces are zeroed and metrics stop accumulating. The loop exits
  early only when ALL conditions have settled or diverged.

SPEEDUP PROFILE:
  ┌────────────────────────────────┬──────────────┐
  │ Mode                           │ Full run     │
  ├────────────────────────────────┼──────────────┤
  │ Original (serial Python)       │ ~5 min       │
  │ Tier-1 (multiprocessing)       │ ~30 s        │
  │ Tier-1 + numba                 │ ~5–10 s      │
  │ Tier-2 GPU (CUDA, A100)        │ ~1–3 s       │
  │ Tier-2 CPU (torch, 16 cores)   │ ~20–40 s     │
  └────────────────────────────────┴──────────────┘
  GPU advantage grows with dataset size. --quick mode overhead is negligible.

REQUIREMENTS:
  pip install torch   (CPU or CUDA build)

USAGE:
  python generate_optimal_pid_gpu.py                     # full, auto device
  python generate_optimal_pid_gpu.py --quick             # smoke-test
  python generate_optimal_pid_gpu.py --device cuda       # force GPU
  python generate_optimal_pid_gpu.py --device cpu        # force CPU
  python generate_optimal_pid_gpu.py --out PATH          # custom output
  python trainer.py PATH                                 # train the model
"""

import argparse, csv, math, sys, time
from datetime import datetime
from pathlib import Path

import numpy as np

try:
    import torch
except ImportError:
    print('ERROR: PyTorch not installed.  Run: pip install torch')
    sys.exit(1)

# Import physics constants and condition builder from the CPU version
from generate_optimal_pid import (
    G, B, DT, MAX_TIME, SCALE, DIVERGE_DEG, SETTLE_DEG, SETTLE_DUR,
    KP_MAX, GAMMA_KD, NOISE_KP, NOISE_KI, NOISE_KD,
    ALPHA_KP_BASE, ALPHA_KP_MAX, ALPHA_KP_SLOPE, ALPHA_KI_BASE, ALPHA_KI_MAX,
    DIST_MAP, CSV_HEADER,
    optimal_gains, perturbed_gains, build_conditions,
)

_SCALE_SQ = SCALE * SCALE
_N_STEPS  = int(MAX_TIME / DT)
_DIV_RAD  = math.radians(DIVERGE_DEG)
_THR_RAD  = math.radians(SETTLE_DEG)

# Reverse map for CSV output
_CODE_TO_DIST = {v: k for k, v in DIST_MAP.items()}


def _build_tensors(conds, device, dtype=torch.float64):
    """Convert condition list to batched tensors. Returns dict of tensors + metadata list."""
    master_rng = np.random.default_rng(42)
    seeds = master_rng.integers(0, 2**32, size=len(conds)).tolist()

    rows = []
    meta = []  # (L, m, ws, wd, dist_str, noisy, Kp, Ki, Kd) for CSV writing
    for (L, m, ws, wd, dist, noisy), seed in zip(conds, seeds):
        rng = np.random.default_rng(seed)
        Kp, Ki, Kd = perturbed_gains(L, m, ws, rng) if noisy else optimal_gains(L, m, ws)
        rows.append((L, m, ws, wd, float(DIST_MAP[dist]), Kp, Ki, Kd))
        meta.append((L, m, ws, wd, dist, noisy, Kp, Ki, Kd))

    def t(col): return torch.tensor([r[col] for r in rows], dtype=dtype, device=device)

    L_t  = t(0); m_t  = t(1); ws_t = t(2); wd_t = t(3)
    dc_t = torch.tensor([int(r[4]) for r in rows], dtype=torch.int32, device=device)
    Kp_t = t(5); Ki_t = t(6); Kd_t = t(7)

    wr   = torch.deg2rad(wd_t)
    Fx0  = ws_t * torch.cos(wr)
    Fy0  = ws_t * torch.sin(wr)

    return {
        'L': L_t, 'm': m_t,
        'Kp': Kp_t, 'Ki': Ki_t, 'Kd': Kd_t,
        'Fx0': Fx0, 'Fy0': Fy0, 'dc': dc_t,
    }, meta


def _run_batch(tensors, device, dtype=torch.float64):
    """Run all simulations in parallel. Returns result tensors."""
    N    = tensors['L'].shape[0]
    z    = lambda: torch.zeros(N, dtype=dtype, device=device)
    L_t  = tensors['L']; m_t = tensors['m']
    Kp_t = tensors['Kp']; Ki_t = tensors['Ki']; Kd_t = tensors['Kd']
    Fx0  = tensors['Fx0']; Fy0 = tensors['Fy0']; dc = tensors['dc']

    # State
    tx=z(); ty=z(); ox=z(); oy=z()
    ix=z(); iy=z()
    prev_ex=z(); prev_ey=z()

    # Metrics
    ISE=z(); IAE=z(); ITAE=z(); max_t=z(); sc=z()
    t_settle = torch.full((N,), -1.0, dtype=dtype, device=device)
    settled  = torch.zeros(N, dtype=torch.bool, device=device)
    diverged = torch.zeros(N, dtype=torch.bool, device=device)

    div_r = torch.tensor(_DIV_RAD, dtype=dtype, device=device)
    thr_r = torch.tensor(_THR_RAD, dtype=dtype, device=device)
    scale_t = torch.tensor(SCALE, dtype=dtype, device=device)
    sq_t    = torch.tensor(_SCALE_SQ, dtype=dtype, device=device)
    b_t     = torch.tensor(B, dtype=dtype, device=device)
    g_t     = torch.tensor(G, dtype=dtype, device=device)
    dt_t    = torch.tensor(DT, dtype=dtype, device=device)
    sd_t    = torch.tensor(SETTLE_DUR, dtype=dtype, device=device)

    for step in range(_N_STEPS):
        t = step * DT

        # Disturbance envelope — scalar per dist_code, broadcast across batch
        f0 = torch.tensor(1.0 if t >= 1.0 else 0.0, dtype=dtype, device=device)
        f1 = torch.tensor(3.0 if 1.0 <= t <= 1.5 else 0.0, dtype=dtype, device=device)
        f2 = torch.tensor(min(t / 10.0, 1.0), dtype=dtype, device=device)
        f3 = torch.tensor(1.0 + 0.4 * math.sin(2.0 * math.pi * t / 3.0),
                          dtype=dtype, device=device)
        f = torch.where(dc == 0, f0,
            torch.where(dc == 1, f1,
            torch.where(dc == 2, f2, f3)))

        Fx = Fx0 * f; Fy = Fy0 * f

        # PID — only update active simulations (not yet settled or diverged)
        active = ~settled & ~diverged
        ex = tx; ey = ty
        ix = (ix + ex * dt_t).clamp(-50.0, 50.0)
        iy = (iy + ey * dt_t).clamp(-50.0, 50.0)
        if step > 0:
            dex = (ex - prev_ex) / dt_t
            dey = (ey - prev_ey) / dt_t
        else:
            dex = torch.zeros_like(ex)
            dey = torch.zeros_like(ey)
        prev_ex = ex.clone(); prev_ey = ey.clone()

        raw_x = Kp_t * ex + Ki_t * ix + Kd_t * dex
        raw_y = Kp_t * ey + Ki_t * iy + Kd_t * dey
        fpx = torch.where(active, (raw_x * scale_t).clamp(-1.0, 1.0) / sq_t,
                          torch.zeros_like(raw_x))
        fpy = torch.where(active, (raw_y * scale_t).clamp(-1.0, 1.0) / sq_t,
                          torch.zeros_like(raw_y))

        # Euler integration
        ax = (Fx - b_t*ox - m_t*g_t*tx - fpx) / (m_t * L_t)
        ay = (Fy - b_t*oy - m_t*g_t*ty - fpy) / (m_t * L_t)
        ox = ox + ax * dt_t; oy = oy + ay * dt_t
        tx = tx + ox * dt_t; ty = ty + oy * dt_t

        tm = (tx**2 + ty**2).sqrt()
        diverged = diverged | (tm > div_r)

        # Update metrics for active sims
        tsq = tx**2 + ty**2
        ISE  = torch.where(active, ISE  + tsq * dt_t, ISE)
        IAE  = torch.where(active, IAE  + tsq.sqrt() * dt_t, IAE)
        ITAE = torch.where(active, ITAE + t * tsq.sqrt() * dt_t, ITAE)
        max_t = torch.where(active & (tm > max_t), tm, max_t)

        # Settle tracking
        sc = torch.where(active & (tm < thr_r), sc + dt_t,
             torch.where(active, torch.zeros_like(sc), sc))
        newly = active & (sc >= sd_t) & ~settled
        t_settle = torch.where(newly,
                                torch.full_like(t_settle, t - SETTLE_DUR),
                                t_settle)
        settled = settled | newly

        # Early exit when all conditions resolved
        if (settled | diverged).all():
            break

    ss = (tx**2 + ty**2).sqrt()
    t_norm = torch.where(t_settle >= 0.0, t_settle,
                         torch.full_like(t_settle, MAX_TIME)) / MAX_TIME
    score = (0.30 * (ISE  / 10.0).clamp(max=1.0) +
             0.20 * (IAE  / 20.0).clamp(max=1.0) +
             0.30 * (ITAE / 200.0).clamp(max=1.0) +
             0.15 * t_norm.clamp(max=1.0) +
             0.05 * (max_t * 57.29578 / 20.0).clamp(max=1.0))

    return {
        'diverged': diverged.cpu().numpy(),
        'ISE':      ISE.cpu().numpy(),
        'IAE':      IAE.cpu().numpy(),
        'ITAE':     ITAE.cpu().numpy(),
        't_settle': t_settle.cpu().numpy(),
        'max_t':    max_t.cpu().numpy(),
        'ss':       ss.cpu().numpy(),
        'score':    score.cpu().numpy(),
    }


def main(out_path, quick, device_str='auto', dtype_str='float64'):
    # Device selection
    if device_str == 'auto':
        device_str = 'cuda' if torch.cuda.is_available() else 'cpu'
    device = torch.device(device_str)
    dtype  = torch.float64 if dtype_str == 'float64' else torch.float32

    conds = build_conditions(quick)
    total = len(conds)
    out   = Path(out_path); out.parent.mkdir(parents=True, exist_ok=True)

    gpu_info = ''
    if device.type == 'cuda':
        gpu_info = f' ({torch.cuda.get_device_name(device)})'

    print(f'\n{"="*64}')
    print(f'  Crane PID GPU Data Generator')
    print(f'  Rows      : {total}')
    print(f'  Device    : {device}{gpu_info}  dtype={dtype_str}')
    print(f'  Output    : {out}')
    print(f'{"="*64}\n')

    print('  Building condition tensors...', end=' ', flush=True)
    tensors, meta = _build_tensors(conds, device, dtype)
    print(f'done  ({total} conditions on {device})\n')

    t0 = time.time()
    print('  Running batched simulation...', end=' ', flush=True)
    results = _run_batch(tensors, device, dtype)
    el = time.time() - t0
    print(f'done  ({el:.2f} s)\n')

    # Write CSV
    ok = failed = 0
    ts_now = datetime.now().isoformat() + 'Z'
    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=CSV_HEADER)
        w.writeheader()
        for i, (L, m, ws, wd, dist, noisy, Kp, Ki, Kd) in enumerate(meta):
            if results['diverged'][i]:
                failed += 1
                continue
            ts_val = float(results['t_settle'][i])
            w.writerow({
                'timestamp': ts_now,
                'L': L, 'm': m,
                'Kp': round(Kp, 4), 'Ki': round(Ki, 4), 'Kd': round(Kd, 4),
                'wind_speed': ws, 'wind_dir_deg': wd, 'disturbance_type': dist,
                'ISE':   round(float(results['ISE'][i]),   4),
                'IAE':   round(float(results['IAE'][i]),   4),
                'ITAE':  round(float(results['ITAE'][i]),  4),
                't_settle': round(ts_val, 2) if ts_val >= 0.0 else '',
                'overshoot_deg':      round(math.degrees(float(results['max_t'][i])), 3),
                'steady_state_error': round(math.degrees(float(results['ss'][i])),   4),
                'score':  round(float(results['score'][i]), 4),
                'status': 'ok',
            })
            ok += 1

    total_el = time.time() - t0
    print(f'{"="*64}')
    print(f'  Done in {total_el:.2f} s  |  ok={ok}  fail/diverged={failed}')
    print(f'  Output: {out}')
    print(f'{"="*64}\n')
    print(f'  Next: python trainer.py "{out}"\n')
    return ok


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--out', default='../data/experiments/model_dataset_auto/model_data.csv')
    p.add_argument('--quick', action='store_true')
    p.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    p.add_argument('--dtype',  default='float64', choices=['float64', 'float32'],
                   help='float32 is faster on GPU but slightly less accurate')
    a = p.parse_args()
    sys.exit(0 if main(a.out, a.quick, a.device, a.dtype) > 0 else 1)
