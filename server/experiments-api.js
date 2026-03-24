// experiments-api.js — REST endpoints for DATA GENERATOR experiment datasets
const fs   = require('fs');
const path = require('path');

const EXPERIMENTS_DIR = path.join(__dirname, '..', 'data', 'experiments');
fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });

const ALLOWED = ['model_dataset_fallback', 'model_dataset_low', 'model_dataset_high', 'model_dataset_manual'];

const GENERATOR_MODES_FILE = path.join(EXPERIMENTS_DIR, 'generator_modes.json');

module.exports = function registerExperimentsAPI(app) {

  // GET /api/generator-modes
  // Return the generator mode configuration from the JSON file
  app.get('/api/generator-modes', (req, res) => {
    if (!fs.existsSync(GENERATOR_MODES_FILE)) {
      return res.status(404).json({ error: 'generator_modes.json not found' });
    }
    try {
      res.json(JSON.parse(fs.readFileSync(GENERATOR_MODES_FILE, 'utf8')));
    } catch (e) {
      res.status(500).json({ error: 'Failed to read generator_modes.json', detail: e.message });
    }
  });

  // GET /api/active-experiment
  // Return the currently active experiment from experiments_config.json
  app.get('/api/active-experiment', (req, res) => {
    const configPath = path.join(__dirname, '..', 'ai-service', 'experiments_config.json');
    if (!fs.existsSync(configPath)) {
      return res.json({ active_experiment: null });
    }
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      let avg_r2 = null, confidence_label = null;
      if (config.meta_path && fs.existsSync(config.meta_path)) {
        const meta = JSON.parse(fs.readFileSync(config.meta_path, 'utf8'));
        avg_r2           = meta.avg_r2           ?? null;
        confidence_label = meta.confidence_label ?? null;
      }
      res.json({
        active_experiment: config.active_experiment ?? null,
        updated_at:        config.updated_at        ?? null,
        avg_r2,
        confidence_label,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read active experiment config', detail: e.message });
    }
  });

  // POST /api/experiments/:name/data
  // Save records as CSV for an experiment (overwrite or append)
  app.post('/api/experiments/:name/data', (req, res) => {
    const { name } = req.params;
    const { records, overwrite } = req.body;

    if (!records?.length)
      return res.status(400).json({ error: 'No records provided' });
    if (!ALLOWED.includes(name))
      return res.status(400).json({ error: `Invalid name: ${name}` });

    const dir     = path.join(EXPERIMENTS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    const csvPath = path.join(dir, 'model_data.csv');

    const header = Object.keys(records[0]).join(',');
    const rows   = records.map(r =>
      Object.values(r).map(v => v === null ? '' : String(v)).join(',')
    );

    if (overwrite || !fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, header + '\n' + rows.join('\n') + '\n');
    } else {
      fs.appendFileSync(csvPath, rows.join('\n') + '\n');
    }

    const lineCount = fs.readFileSync(csvPath, 'utf8')
      .split('\n').filter(l => l.trim()).length - 1;

    res.json({ saved: records.length, total_in_file: lineCount, path: csvPath });
  });

  // POST /api/experiments/:name/log
  // Save generation log JSON
  app.post('/api/experiments/:name/log', (req, res) => {
    const { name } = req.params;
    if (!ALLOWED.includes(name))
      return res.status(400).json({ error: `Invalid name: ${name}` });

    const dir = path.join(EXPERIMENTS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'model_generation_log.json'),
      JSON.stringify(req.body, null, 2)
    );
    res.json({ saved: true });
  });

  // GET /api/experiments
  // Return status of all three datasets
  app.get('/api/experiments', (req, res) => {
    const result = ALLOWED.map(name => {
      const dir      = path.join(EXPERIMENTS_DIR, name);
      const csvPath  = path.join(dir, 'model_data.csv');
      const metaPath = path.join(dir, 'model_metadata.json');
      const logPath  = path.join(dir, 'model_generation_log.json');

      let rowCount = 0;
      if (fs.existsSync(csvPath)) {
        rowCount = fs.readFileSync(csvPath, 'utf8')
          .split('\n').filter(l => l.trim()).length - 1;
      }

      let modelMeta = null;
      if (fs.existsSync(metaPath)) {
        try { modelMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
        catch { /* skip malformed json */ }
      }

      let genLog = null;
      if (fs.existsSync(logPath)) {
        try { genLog = JSON.parse(fs.readFileSync(logPath, 'utf8')); }
        catch { /* skip malformed json */ }
      }

      return {
        name,
        has_data:   rowCount > 0,
        row_count:  rowCount,
        has_model:  modelMeta !== null,
        model_meta: modelMeta,
        gen_log:    genLog,
      };
    });
    res.json(result);
  });

  // DELETE /api/experiments/:name
  // Remove all data and model files for an experiment
  app.delete('/api/experiments/:name', (req, res) => {
    const { name } = req.params;
    if (!ALLOWED.includes(name))
      return res.status(400).json({ error: `Invalid name: ${name}` });

    const dir = path.join(EXPERIMENTS_DIR, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
    res.json({ deleted: true, name });
  });

  // POST /api/experiments/:name/activate
  // Set the active experiment by writing experiments_config.json for the AI service
  app.post('/api/experiments/:name/activate', (req, res) => {
    const { name } = req.params;
    if (!ALLOWED.includes(name))
      return res.status(400).json({ error: `Invalid name: ${name}` });

    const modelPath = path.join(EXPERIMENTS_DIR, name, 'model.joblib');
    const metaPath  = path.join(EXPERIMENTS_DIR, name, 'model_metadata.json');

    if (!fs.existsSync(modelPath)) {
      return res.status(404).json({
        error: `No model found for ${name}. Build the model first.`
      });
    }

    const config = {
      active_experiment: name,
      updated_at:        new Date().toISOString(),
      model_path:        modelPath,
      meta_path:         metaPath,
    };
    const configPath = path.join(__dirname, '..', 'ai-service', 'experiments_config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}

    const avgR2 = meta?.avg_r2 ?? null;
    const confidenceLabel = meta?.confidence_label ?? null;

    res.json({
      activated:        name,
      avg_r2:           avgR2,
      confidence_label: confidenceLabel,
      note: 'Call /api/ai/switch-experiment to reload the model without restarting ai-service',
    });
  });
};
