# 🏗️ Tower Crane Load Stabilization Simulator
### *DŹWIK — Digital Twin of an Active Load Stabilizer*

> An interactive physics-based web simulator of a tower crane with an active drone-propeller load stabilization system, plus an automated PID optimizer. Built as a digital twin prototype for educational and research purposes.

---

## 🎯 What it does

The simulator models a suspended load (cargo) on a crane rope as a **spherical pendulum**. Disturbances (wind gusts, impulses) cause the load to swing. A **cascade PID controller** drives four drone-style propellers mounted at the mid-cable point to counteract the swing in real time.

A dedicated **PID Optimizer tab** allows automated grid-search and Ziegler-Nichols tuning across arbitrary parameter ranges and test scenarios, with interactive charts for analysis and one-click gain application.

An **AI DRIVEN tab** runs a fully automated 6-minute scenario where a machine-learning model (GradientBoosting, trained on accumulated PID test results) selects optimal gains in real time, with an optional Ollama LLM providing natural-language explanations of each decision.

A **Reports tab** stores and compares AI-driven sessions, showing timeseries charts, phase breakdowns, and multi-session bar-chart comparisons.

### ✨ Key features

| Feature | Description |
|---|---|
| ⚙️ **Physics engine** | Linearized spherical pendulum with RK4 numerical integration (dt = 16 ms) |
| 🎛️ **PID stabilizer** | Independent X/Y axis controllers with tunable Kp, Ki, Kd gains |
| 🚁 **Propeller mixer** | Maps 2D force output to N/E/S/W motor PWM signals with yaw correction |
| 🌐 **3D visualization** | Three.js scene with crane structure, spinning propellers, force vectors, wind arrow, and load trajectory trail |
| 🗺️ **2D top-down view** | Live load position, force vectors, trail, and alarm circle (5°/10°/15° rings) |
| 📈 **Angle history chart** | Last 30 seconds of θx, θy, \|θ\| with ±15° warning lines |
| 📡 **Live telemetry** | Angles, motor PWM bars (bidirectional teal/orange), state badge (READY / STABILIZING / WARNING / DRIFTING / ALARM) |
| 🌗 **Dark / light theme** | Toggle between dark industrial and light UI |
| 💨 **Wind controls** | Speed/direction sliders, step/impulse/ramp disturbance types, gusty wind mode |
| 🔬 **PID Optimizer** | Automated grid-search + Ziegler-Nichols tuning with physics-aware range suggestions |
| 📊 **Interactive charts** | Heatmap, time-response, scatter, bar — all with hover tooltips and click-to-apply |
| 💾 **Results persistence** | Save/load test results via server API; CSV export |
| 🤖 **AI DRIVEN tab** | 6-minute automated scenario; ML model predicts optimal PID gains every 5 s; optional LLM explanations |
| 📋 **Reports tab** | Session list, timeseries detail view, phase table, multi-session comparison bar chart |

---

## 🖥️ Screenshot

![Screenshot of DŹWIK](img/dzwik01.png)

![Screenshot of DŹWIK](img/dzwik02.png)

---

## 📦 Requirements

- 🟢 **Node.js** ≥ 18
- 📦 **npm** ≥ 9
- 🌐 A modern browser with WebGL support (Chrome, Firefox, Edge, Safari)

> No build step, bundler, or transpiler required. The backend is a minimal Express server; all frontend code is plain ES6 modules loaded directly by the browser.

---

## 🚀 Running locally

```bash
# 1. Clone the repository
git clone https://github.com/mmartofel/crane_load_stabilization_simulator.git
cd crane-simulator

# 2. Install dependencies (Express only)
npm install

# 3. Start the server
npm start

# 4. Open in browser 🎉
http://localhost:3000
```

The server serves all static files from `public/` and listens on port 3000.

### 🤖 AI features (optional)

The AI DRIVEN tab requires the Python/Flask ai-service running on port 5001:

```bash
cd ai-service
pip install flask scikit-learn numpy pandas requests
python app.py
```

The service exposes `/api/ai/predict`, `/api/ai/train`, `/api/ai/status`, and `/api/ai/ollama`. If the ai-service is not running, the AI DRIVEN tab falls back to analytical PID estimation automatically.

---

## 🗂️ Project structure

```
crane-simulator/
├── 🖥️  server.js               # Express static-file server + REST API (results + sessions)
├── 📋  package.json
├── 📁  public/
│   ├── 🏠  index.html           # App shell — tabbed layout (SIMULATOR | PID TESTS | AI DRIVEN | REPORTS)
│   ├── 🎨  style.css            # CSS variables, dark/light themes, layout
│   ├── 🎨  results.css          # PID optimizer tab styling
│   ├── 🎨  ai-ui.css            # AI DRIVEN tab styles
│   ├── 🎨  reports.css          # Reports tab styles
│   ├── ⚙️   sim.js              # Physics: Pendulum, PIDController, PropellerMixer classes
│   ├── 🌐  renderer.js          # Three.js 3D scene (CraneRenderer class)
│   ├── 🎮  ui.js                # Animation loop, slider/button wiring, canvas charts
│   ├── 🔬  optimizer.js         # BatchOptimizer, Ziegler-Nichols, scoring, physics range calc
│   ├── ⚡  optimizer-worker.js  # Web Worker for large batch grid-search (>500 tests)
│   ├── 📊  results-ui.js        # PID tab UI: charts, tooltips, table, modal, sidebar, API calls
│   ├── 🤖  ai-ui.js             # AI DRIVEN tab: AIController, animation loop, top-view canvas
│   ├── 🎬  ai-scenario.js       # 6-minute scenario definition (phases + wind events)
│   └── 📋  reports-ui.js        # Reports tab: session list, detail view, comparison chart
├── 📁  ai-service/
│   ├── 🐍  app.py               # Flask REST API: /api/ai/predict, /train, /status, /ollama
│   └── 🧠  model.py             # PIDPredictor: GradientBoosting + StandardScaler pipeline
└── 📁  data/
    ├── 📄  pid_results.csv       # Accumulated PID test results used to train the ML model
    └── 📄  model_meta.json       # Model metadata (R², row count, training timestamp)
```

---

## 🎮 Controls — Simulator tab

| Control | Description |
|---|---|
| 💨 Wind speed / direction | Set steady-state wind force |
| 🪢 Rope length | Pendulum length (affects oscillation frequency) |
| ⚖️ Load mass | Cargo weight |
| 🎛️ Kp / Ki / Kd | PID gains — tune stabilizer response |
| ▶️ Play / ⏸️ Pause | Start or freeze the simulation |
| 🔄 Reset | Return load to rest, clear graph and trail |
| 🚁 Stabilizer ON/OFF | Enable or disable propeller control |
| 💥 Wind impulse | Apply a 3× wind burst for 1 second |
| 🌪️ Gusty wind | Enable random wind magnitude variations |
| ☀️ LIGHT / 🌙 DARK | Toggle UI theme |

---

## 🔬 PID Optimizer tab

Switch to the **PID TESTS** tab to access automated tuning tools:

| Feature | Description |
|---|---|
| 📐 **Grid search** | Sweep Kp × Ki × Kd ranges with configurable step counts across multiple L/m/disturbance scenarios |
| ⚡ **Web Worker** | Batches > 500 tests run in a background worker to keep the UI responsive |
| 🎚️ **Ziegler-Nichols** | Binary-search for ultimate gain (Ku) and oscillation period (Tu); auto-computes Kp/Ki/Kd |
| 📏 **Physics ranges** | Suggested Kp/Ki/Kd bounds derived from rope length (T = 2π√(L/g)) and load mass |
| 📊 **Heatmap** | Kp × Kd score grid — hover for values, click to apply |
| 📈 **Time response** | Top-5 theta(t) curves — hover highlights curve, click to apply |
| 🎯 **Scatter plot** | Settling time vs. overshoot — "good zone" (Ts < 10 s, OS < 5°), hover/click |
| 📉 **Bar chart** | Top-10 composite scores — hover/click to apply |
| 🏆 **Best sidebar** | Top-5 ranked results always visible with one-click apply |
| 📋 **Results table** | 12-column sortable/filterable table; row click opens full detail modal |
| 💾 **Persistence** | Save to server, load saved results, export as CSV |

### Composite score metrics

Each test is evaluated on: **ISE**, **IAE**, **ITAE**, settling time (Ts), overshoot, and steady-state error — combined into a single weighted score (lower = better).

---

## 🤖 AI DRIVEN tab

Switch to the **AI DRIVEN** tab for a fully automated 6-minute demonstration scenario:

| Feature | Description |
|---|---|
| 🎬 **Scenario phases** | Pre-defined wind/condition timeline (`ai-scenario.js`); initial wind 8 m/s with early gust for visible deflection |
| 🧠 **ML gain prediction** | `AIController` requests PID gains from ai-service every 5 s using 7 physics features (L, m, wind, ω₀, T) |
| 🔄 **Smooth transitions** | Predicted gains blend in over 2 s to avoid step changes in force output |
| ⚡ **Forced override** | Controller can force-apply critical gains if θ exceeds safety threshold |
| 💬 **LLM explanations** | Optional Ollama integration provides natural-language reasoning for each gain change (20 s proxy timeout); panel shows descriptive fallback when AI service or Ollama is unavailable |
| 📜 **Decision History** | Shows the 3 most recent AI decisions (gain deltas, fallback/forced flags) |
| 🗺️ **Top-down canvas** | Full propeller force vectors + gradient trail, matching SIMULATOR layout |
| 📊 **Motor bars M1–M4** | Live bidirectional PWM display for all four propellers |
| 🚁 **Stabilizer ON/OFF** | Toggle propeller control mid-scenario (same as SIMULATOR); button in CONTROLS section |
| 💾 **Auto-save** | Session metrics auto-saved to REPORTS at end of scenario |

---

## 📋 Reports tab

Switch to the **REPORTS** tab to review and compare AI-driven sessions:

| Feature | Description |
|---|---|
| 📃 **Session list** | All saved sessions sorted by date; click to open detail view |
| 📈 **Timeseries chart** | θ(t) for the full 6-minute run with phase boundary markers |
| 📋 **Phase table** | Per-phase avg/max θ, AI update count, forced overrides (all 4 phases visible via scroll) |
| 📊 **Multi-session comparison** | Select 2–4 sessions; bar chart shows avg θ per session with auto-scaled Y-axis and degree labels |
| 🗑️ **Delete selected** | Checkbox-select one or more sessions and delete them permanently; detail panel auto-advances to the next available session |

---

## 🧮 Physics model

Linearized spherical pendulum (small-angle approximation):

```
m·L·θx'' = F_wind_x − b·θx' − m·g·θx − F_prop_x
m·L·θy'' = F_wind_y − b·θy' − m·g·θy − F_prop_y
```

Integrated with **4th-order Runge-Kutta** at a fixed 16 ms timestep. Propeller forces are computed by the PID controller and mixed into four motor signals (North, East, South, West).

---

## 📚 External libraries (CDN, no install needed)

| Library | Version | Use |
|---|---|---|
| 🔺 Three.js | r128 | 3D rendering |
| 🎥 Three OrbitControls | r128 | Interactive camera |

---

🎓 *Developed as a prototype at the University of Southern Denmark.*
