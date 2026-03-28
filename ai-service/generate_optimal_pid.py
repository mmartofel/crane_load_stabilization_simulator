#!/usr/bin/env python3
"""
generate_optimal_pid.py  —  v4 (analytical, b=1.2)
══════════════════════════════════════════════════
Generates training CSV where every row contains Kp/Ki/Kd derived from
control-theory formulas, not simulation scoring.

WHY ANALYTICAL:
  Grid-search generates all (Kp,Ki,Kd) combinations for the same (L,m,wind)
  condition, so the ML model sees many different targets for the same input and
  converges to the mean rather than the optimum (R²≈0).  The analytical
  approach creates a smooth, learnable mapping:
    Kp = alpha(wind_loading) * m*g/L    alpha grows with wind/gravity ratio
    Ki = beta(wind_loading)  * Kp / T   small integral to remove SS error
    Kd = GAMMA_KD * T                   non-zero derivative for b=1.2 system
  Plus Gaussian perturbations so the ML model generalises not memorises.

PHYSICS ALIGNMENT (v4 change):
  B is now 1.2, matching sim.js (was 0.15 — 8× mismatch causing poor real-world
  performance even when R² was high on training data).  With B=1.2 the system
  is more naturally damped so Kp alphas are reduced and Kd is non-zero.

USAGE:
  python generate_optimal_pid.py             # full dataset  (~5 min)
  python generate_optimal_pid.py --quick     # smoke-test    (~20 s)
  python generate_optimal_pid.py --out PATH  # custom output path
  python trainer.py PATH                     # train the model
"""

import argparse, csv, sys, time
from datetime import datetime
from pathlib import Path

import numpy as np

# ── Constants ─────────────────────────────────────────────────────────────────
G            = 9.81
B            = 1.2    # must match sim.js (was 0.15 — caused 8× damping mismatch)
DT           = 0.016
MAX_TIME     = 40.0
DIVERGE_DEG  = 45.0
SETTLE_DEG   = 1.0
SETTLE_DUR   = 2.0

# With B=1.2 the system is heavily damped — lower Kp alphas prevent over-actuation.
# Range 0.30–0.55 aligns with the model.py analytical fallback (0.55 * m*g/L).
ALPHA_KP_BASE  = 0.30
ALPHA_KP_MAX   = 0.55
ALPHA_KP_SLOPE = 3.0
ALPHA_KI_BASE  = 0.04
ALPHA_KI_MAX   = 0.10

# Kd is non-zero for the b=1.2 system — aligns with model.py fallback (T * 0.4).
GAMMA_KD     = 0.40   # Kd = GAMMA_KD * T, where T = 2π√(L/g)
NOISE_KD     = 0.12   # ±12% Kd noise

NOISE_KP = 0.08
NOISE_KI = 0.15

CSV_HEADER = [
    'timestamp','L','m','Kp','Ki','Kd',
    'wind_speed','wind_dir_deg','disturbance_type',
    'ISE','IAE','ITAE','t_settle','overshoot_deg',
    'steady_state_error','score','status',
]

# ── Physics helpers ───────────────────────────────────────────────────────────

def kp_critical(L, m):   return m * G / L
def period(L):            return 2.0 * np.pi * np.sqrt(L / G)
def wind_loading(ws, m):  return (ws / (m * G)) / np.deg2rad(5.0)

def optimal_gains(L, m, ws):
    kpc = kp_critical(L, m)
    T   = period(L)
    wl  = wind_loading(ws, m)
    akp = ALPHA_KP_BASE + (ALPHA_KP_MAX - ALPHA_KP_BASE) * (1 - np.exp(-ALPHA_KP_SLOPE * wl))
    aki = ALPHA_KI_BASE + (ALPHA_KI_MAX - ALPHA_KI_BASE) * (1 - np.exp(-ALPHA_KP_SLOPE * wl))
    Kd  = GAMMA_KD * T   # non-zero derivative — needed for b=1.2 real simulator
    return akp * kpc, aki * akp * kpc / T, Kd

def perturbed_gains(L, m, ws, rng):
    Kp0, Ki0, Kd0 = optimal_gains(L, m, ws)
    kpc = kp_critical(L, m); T = period(L)
    Kp  = float(np.clip(Kp0 * (1 + rng.normal(0, NOISE_KP)), 0.05*kpc, 0.90*kpc))
    Ki  = float(np.clip(Ki0 * (1 + rng.normal(0, NOISE_KI)), 0.0, 0.3*Kp/T))
    Kd  = float(np.clip(Kd0 * (1 + rng.normal(0, NOISE_KD)), 0.0, 1.5*T))
    return Kp, Ki, Kd

# ── Simulation ────────────────────────────────────────────────────────────────

def simulate(L, m, Kp, Ki, Kd, ws, wd, dist='step'):
    n = int(MAX_TIME / DT)
    wr = np.deg2rad(wd)
    Fx0 = ws * np.cos(wr); Fy0 = ws * np.sin(wr)
    div = np.deg2rad(DIVERGE_DEG); thr = np.deg2rad(SETTLE_DEG)
    tx=ty=ox=oy=ix=iy=pex=pey=0.
    ISE=IAE=ITAE=max_t=sc=0.; ts=None

    for step in range(n):
        t = step * DT
        if   dist=='step':    f = 1. if t>=1. else 0.
        elif dist=='impulse': f = 3. if 1.<=t<=1.5 else 0.
        elif dist=='ramp':    f = min(t/10., 1.)
        else:                 f = 1.+0.4*np.sin(2*np.pi*t/3.)

        Fx=Fx0*f; Fy=Fy0*f
        ex=-tx; ey=-ty
        ix=float(np.clip(ix+ex*DT,-10,10)); iy=float(np.clip(iy+ey*DT,-10,10))
        dex=(ex-pex)/DT if step>0 else 0.; pex=ex
        dey=(ey-pey)/DT if step>0 else 0.; pey=ey
        fpx=float(np.clip(Kp*ex+Ki*ix+Kd*dex,-50,50))
        fpy=float(np.clip(Kp*ey+Ki*iy+Kd*dey,-50,50))
        ax=(Fx-B*ox-m*G*tx-fpx)/(m*L); ay=(Fy-B*oy-m*G*ty-fpy)/(m*L)
        ox+=ax*DT; oy+=ay*DT; tx+=ox*DT; ty+=oy*DT

        tm=np.hypot(tx,ty)
        if tm>div: return None
        tsq=tx*tx+ty*ty
        ISE+=tsq*DT; IAE+=np.sqrt(tsq)*DT; ITAE+=t*np.sqrt(tsq)*DT
        max_t=max(max_t,tm)
        if tm<thr:
            sc+=DT
            if sc>=SETTLE_DUR and ts is None: ts=t-SETTLE_DUR
        else: sc=0.

    ss=np.hypot(tx,ty)
    score=(0.30*min(ISE/10,1)+0.20*min(IAE/20,1)+0.30*min(ITAE/200,1)
           +0.15*min((ts or MAX_TIME)/MAX_TIME,1)+0.05*min(np.rad2deg(max_t)/20,1))
    return {
        'ISE':round(float(ISE),4),'IAE':round(float(IAE),4),'ITAE':round(float(ITAE),4),
        't_settle':round(float(ts),2) if ts else None,
        'overshoot_deg':round(float(np.rad2deg(max_t)),3),
        'steady_state_error':round(float(np.rad2deg(ss)),4),
        'score':round(float(score),4),'status':'ok',
    }

# ── Parameter space ───────────────────────────────────────────────────────────

def build_conditions(quick):
    if quick:
        L_v=[5.,10.,15.]; m_v=[10.,50.,200.]
        ws_v=[3.,10.]; wd_v=[45.,225.]; dist_v=['step']; n_p=2
    else:
        L_v=[3.,5.,7.,10.,12.,15.,20.]
        m_v=[2.,5.,10.,20.,50.,100.,200.,500.]
        ws_v=[2.,5.,8.,12.,16.,20.]
        wd_v=[0.,45.,90.,135.,180.,270.,315.]
        dist_v=['step','impulse','ramp','gust']; n_p=6

    conds=[]
    for L in L_v:
        for m in m_v:
            for ws in ws_v:
                for wd in wd_v:
                    for d in dist_v:
                        conds.append((L,m,ws,wd,d,False))       # exact optimal
                        for _ in range(n_p):
                            conds.append((L,m,ws,wd,d,True))    # perturbed
    return conds

# ── Main ──────────────────────────────────────────────────────────────────────

def main(out_path, quick):
    out=Path(out_path); out.parent.mkdir(parents=True,exist_ok=True)
    conds=build_conditions(quick); total=len(conds)
    rng=np.random.default_rng(42)
    est=total*0.05
    print(f'\n{"="*62}')
    print(f'  Crane PID Analytical Data Generator  v3')
    print(f'  Rows      : {total}  |  Est. time : ~{est/60:.1f} min')
    print(f'  Output    : {out}')
    print(f'{"="*62}\n')

    ok=failed=0; t0=time.time()
    with open(out,'w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=CSV_HEADER); w.writeheader()
        for i,(L,m,ws,wd,dist,noisy) in enumerate(conds):
            Kp,Ki,Kd = perturbed_gains(L,m,ws,rng) if noisy else optimal_gains(L,m,ws)
            r=simulate(L,m,Kp,Ki,Kd,ws,wd,dist)
            if r is None: failed+=1
            else:
                w.writerow({'timestamp':datetime.now().isoformat()+'Z',
                    'L':L,'m':m,'Kp':round(Kp,4),'Ki':round(Ki,4),'Kd':round(Kd,4),
                    'wind_speed':ws,'wind_dir_deg':wd,'disturbance_type':dist,
                    **{k:(r[k] if r[k] is not None else '') for k in
                       ['ISE','IAE','ITAE','t_settle','overshoot_deg',
                        'steady_state_error','score','status']}})
                f.flush(); ok+=1

            if (i+1)%max(1,total//60)==0 or i==total-1:
                pct=(i+1)/total*100; el=time.time()-t0
                eta=el/(i+1)*(total-i-1)
                bar='█'*int(pct/5)+'░'*(20-int(pct/5))
                tag='N' if noisy else 'O'
                print(f'\r  [{bar}]{pct:5.1f}%  ok={ok} fail={failed}'
                      f'  ETA {eta/60:.1f}m  L={L:.0f} m={m:.0f}'
                      f'  [{tag}]Kp={Kp:.2f}     ',end='',flush=True)

    el=time.time()-t0
    print(f'\n\n{"="*62}')
    print(f'  Done in {el/60:.1f} min  |  ok={ok}  fail={failed}')
    print(f'  Output: {out}')
    print(f'{"="*62}\n')
    print(f'  Next: python trainer.py "{out}"\n')
    return ok

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--out',default='../data/experiments/model_dataset_auto/model_data.csv')
    p.add_argument('--quick',action='store_true')
    a=p.parse_args()
    sys.exit(0 if main(a.out,a.quick)>0 else 1)
