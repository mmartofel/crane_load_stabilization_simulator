// ai-scenario.js — 6-minute AI DRIVEN scenario definition (exposed as global)
window.AI_SCENARIO = {
  duration: 360,
  phases: [
    { t_start: 0,   t_end: 108, label: 'Cycle 1 — load 50 kg',   color: '#1D9E75' },
    { t_start: 108, t_end: 180, label: 'Empty run',               color: '#5F5E5A' },
    { t_start: 180, t_end: 330, label: 'Cycle 2 — load 150 kg',   color: '#378ADD' },
    { t_start: 330, t_end: 360, label: 'Finish',                   color: '#5F5E5A' },
  ],
  events: [
    // ── CYCLE 1 ──────────────────────────────────────────────────────────
    { t: 0,   type: 'set',    params: { L: 12, m: 50,  wind_speed: 4,  wind_dir: 60  }, label: 'Attach 50 kg, full rope' },
    { t: 10,  type: 'ramp',   params: { L: 4 },          duration: 25,                  label: 'Hoist L: 12→4 m' },
    { t: 30,  type: 'gust',   params: { multiplier: 2.0, duration: 3 },                 label: 'Gust ×2 during hoisting' },
    { t: 40,  type: 'rotate', params: { yaw_delta: 120 }, duration: 15,                 label: 'Tower rotation +120°' },
    { t: 60,  type: 'ramp',   params: { wind_speed: 10, wind_dir: 200 }, duration: 20,  label: 'Wind increases → 10 m/s S' },
    { t: 85,  type: 'ramp',   params: { L: 10 },         duration: 20,                  label: 'Lower L: 4→10 m' },
    { t: 108, type: 'set',    params: { m: 2,  wind_speed: 6 },                         label: '⚡ DETACH — hook empty (m=2kg)' },
    // ── EMPTY RUN ─────────────────────────────────────────────────────────
    { t: 115, type: 'ramp',   params: { L: 14 },         duration: 15,                  label: 'Lower hook L: 10→14 m' },
    { t: 130, type: 'rotate', params: { yaw_delta: -180 }, duration: 20,                label: 'Tower return −180°' },
    { t: 155, type: 'gust',   params: { multiplier: 2.5, duration: 2 },                 label: 'Gust during empty run' },
    { t: 170, type: 'set',    params: { wind_speed: 3,  wind_dir: 90 },                 label: 'Wind subsides' },
    // ── CYCLE 2 ──────────────────────────────────────────────────────────
    { t: 180, type: 'set',    params: { m: 150, L: 14 },                                label: '⚡ ATTACH 150 kg' },
    { t: 190, type: 'ramp',   params: { L: 5 },          duration: 30,                  label: 'Hoist heavy load L: 14→5 m' },
    { t: 210, type: 'ramp',   params: { wind_speed: 14, wind_dir: 315 }, duration: 15,  label: 'Strong NW wind 14 m/s' },
    { t: 230, type: 'gust',   params: { multiplier: 1.8, duration: 4 },                 label: 'Gust during transport' },
    { t: 240, type: 'rotate', params: { yaw_delta: 90 }, duration: 20,                  label: 'Tower rotation +90° with load' },
    { t: 265, type: 'ramp',   params: { wind_speed: 5,  wind_dir: 90 },  duration: 25,  label: 'Wind dies down' },
    { t: 290, type: 'ramp',   params: { L: 12 },         duration: 20,                  label: 'Lower L: 5→12 m' },
    { t: 315, type: 'gust',   params: { multiplier: 2.2, duration: 2 },                 label: 'Final gust' },
    { t: 330, type: 'set',    params: { m: 2 },                                          label: '⚡ DETACH — end of cycle 2' },
    { t: 340, type: 'set',    params: { wind_speed: 2,  wind_dir: 45 },                 label: 'Calm conditions' },
    { t: 360, type: 'end',    params: {},                                                label: 'End of scenario' }
  ]
};
