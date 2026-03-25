const express = require('express');
const path    = require('path');
const fs      = require('fs');
const resultsApi = require('./server/results-api');
const registerExperimentsAPI = require('./server/experiments-api');

const app  = express();
const PORT = 3000;

const SESSIONS_DIR  = path.join(__dirname, 'data', 'ai_sessions');
const MODEL_META    = path.join(__dirname, 'data', 'experiments', 'model_dataset_manual', 'model_metadata.json');
const EXPERIMENTS_CONFIG = path.join(__dirname, 'ai-service', 'experiments_config.json');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.json({ limit: '50mb' }));
app.use('/api/results', resultsApi);

// ── EXPERIMENTS API (DATA GENERATOR) ─────────────────────────────────────
registerExperimentsAPI(app);

// ── PROXY TO AI SERVICE (Python FastAPI :8000) ────────────────────────────

app.post('/api/ai/predict', async (req, res) => {
  try {
    const r = await fetch('http://localhost:8000/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.body?.use_ollama_explanation ? 20000 : 5000)
    });
    res.json(await r.json());
  } catch {
    // Analytical fallback when AI service is unavailable
    const { L = 10, m = 50 } = req.body;
    const g = 9.81, T = 2 * Math.PI / Math.sqrt(g / Math.max(L, 0.1));
    res.json({
      Kp: Math.min((m * g / Math.max(L, 0.1)) * 0.55, 18),
      Ki: 0.1 / Math.max(L / 10, 0.1),
      Kd: T * 0.4,
      confidence: 0, model: 'analytical_fallback', fallback: true,
      explanation: null, adjustment: 'none'
    });
  }
});

app.post('/api/ai/train', async (req, res) => {
  try {
    const r = await fetch('http://localhost:8000/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (e) {
    res.status(503).json({ error: 'AI service unavailable', detail: e.message });
  }
});

app.post('/api/ai/switch-experiment', async (req, res) => {
  try {
    const r = await fetch('http://localhost:8000/switch-experiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(5000)
    });
    res.json(await r.json());
  } catch (e) {
    res.status(503).json({ error: 'AI service unavailable', detail: e.message });
  }
});

app.get('/api/ai/status', async (req, res) => {
  try {
    const r = await fetch('http://localhost:8000/status',
      { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    // Attach metadata from the active experiment (or fall back to model_dataset_manual)
    let metaPath = MODEL_META;
    if (fs.existsSync(EXPERIMENTS_CONFIG)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(EXPERIMENTS_CONFIG, 'utf8'));
        if (cfg.meta_path) metaPath = cfg.meta_path;
      } catch {}
    }
    if (fs.existsSync(metaPath)) {
      data.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    res.json(data);
  } catch {
    res.json({ trained: false, available: false });
  }
});

// ── AI DRIVEN SESSION STORAGE ─────────────────────────────────────────────

app.post('/api/sessions', (req, res) => {
  const session = req.body;
  if (!session.session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }
  const filename = `${session.session_id}.json`;
  fs.writeFileSync(
    path.join(SESSIONS_DIR, filename),
    JSON.stringify(session, null, 2)
  );
  res.json({ saved: true, filename });
});

app.get('/api/sessions', (req, res) => {
  if (!fs.existsSync(SESSIONS_DIR)) return res.json([]);
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse();  // newest first
  const sessions = files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch { return null; }
  }).filter(Boolean);
  res.json(sessions);
});

app.get('/api/sessions/:id', (req, res) => {
  const file = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.delete('/api/sessions/:id', (req, res) => {
  const file = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ deleted: true });
});

// ── CSV ROW COUNT (used by BUILD MODEL button) ────────────────────────────

app.get('/api/csv-stats', (req, res) => {
  const csvPath = path.join(__dirname, 'data', 'experiments', 'model_dataset_manual', 'model_data.csv');
  if (!fs.existsSync(csvPath)) return res.json({ rows: 0, exists: false });
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows    = content.split('\n').filter(l => l.trim()).length - 1; // minus header
  res.json({ rows, exists: true });
});

// ── STATIC FILES ──────────────────────────────────────────────────────────

// Prevent browser caching of static assets so changes are always served fresh
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DIGITAL TWEEN - Tower Crane Load Stabilizer Simulator running at http://localhost:${PORT}`);
});
