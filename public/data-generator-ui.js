// data-generator-ui.js — DATA GENERATOR tab logic
// Generates isolated training datasets (FALLBACK / LOW / HIGH confidence)
// via a headless physics Web Worker and saves them to the server.

// ── Mode definitions ────────────────────────────────────────────────────────
// Loaded at runtime from /api/generator-modes (data/experiments/generator_modes.json).
// The computed properties total_tests and est_minutes are added by enrichMode().
let GENERATOR_MODES = null;

function enrichMode(mode) {
  Object.defineProperty(mode, 'total_tests', {
    get() {
      return this.L_values.length * this.m_values.length *
             this.Kp_steps * this.Ki_steps * this.Kd_steps *
             this.wind_configs.length;
    },
    configurable: true,
  });
  Object.defineProperty(mode, 'est_minutes', {
    get() { return Math.round(this.total_tests * 0.003 / 60 * 10) / 10; },
    configurable: true,
  });
  return mode;
}

async function loadGeneratorModes() {
  const resp = await fetch('/api/generator-modes');
  if (!resp.ok) throw new Error(`Failed to load generator modes: ${resp.status}`);
  const data = await resp.json();
  GENERATOR_MODES = {};
  for (const [key, mode] of Object.entries(data)) {
    if (key.startsWith('_')) continue;  // skip metadata keys like _comment
    GENERATOR_MODES[key] = enrichMode(mode);
  }
}

// ── DataGeneratorUI class ───────────────────────────────────────────────────
class DataGeneratorUI {
  constructor() {
    this.selectedMode = 'fallback';
    this.activeWorker = null;
    this.isGenerating = false;
    this.experiments  = {};     // state of A/B/C fetched from /api/experiments
    this.activeConfig = null;   // mirrors ai-service/experiments_config.json
    this.batchBuffer  = [];
    this.BATCH_SIZE   = 500;    // chunk size for HTTP saves
    this.startTime    = null;
  }

  async init() {
    await loadGeneratorModes();
    this.renderModeSelector();
    this._bindAdvancedPanel();
    await this.refreshExperimentsState();
    this.renderConfigPreview();
    this.renderDatasetStatusCards();
    this._renderActiveModelBar();
  }

  // ── Section A: mode radio cards ──────────────────────────────
  renderModeSelector() {
    const container = document.getElementById('dg-mode-selector');
    if (!container) return;
    container.innerHTML = Object.entries(GENERATOR_MODES).map(([key, mode]) => {
      const isSelected = key === this.selectedMode;
      return `
        <label class="mode-card ${isSelected ? 'selected' : ''}"
               data-mode="${key}"
               onclick="dataGeneratorUI.selectMode('${key}')">
          <input type="radio" name="dg-mode" value="${key}"
                 ${isSelected ? 'checked' : ''} style="display:none">
          <div class="mode-card-header">
            <span class="mode-badge"
                  style="background:${mode.bgColor};color:${mode.color}">
              ${mode.label}
            </span>
            <span class="mode-expected-r2" style="color:${mode.color}">
              R² ${mode.expected_r2}
            </span>
          </div>
          <div class="mode-description">${mode.description}</div>
          <div class="mode-quick-stats">
            <span>~${mode.total_tests.toLocaleString()} tests</span>
            <span>|</span>
            <span>~${mode.est_minutes} min</span>
          </div>
        </label>`;
    }).join('');
  }

  selectMode(key) {
    this.selectedMode = key;
    document.querySelectorAll('.mode-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.mode === key);
    });
    this.renderConfigPreview();
  }

  // ── Section B: config preview ────────────────────────────────
  renderConfigPreview() {
    const mode  = GENERATOR_MODES[this.selectedMode];
    const total = mode.total_tests;
    const est   = mode.est_minutes;

    const paramRows = [
      { label: 'L',    count: mode.L_values.length,
        range: `${mode.L_values[0]}–${mode.L_values.at(-1)} m` },
      { label: 'm',    count: mode.m_values.length,
        range: `${mode.m_values[0]}–${mode.m_values.at(-1)} kg` },
      { label: 'Kp',   count: mode.Kp_steps,
        range: `${mode.Kp_min}–${mode.Kp_max}` },
      { label: 'Ki',   count: mode.Ki_steps,
        range: `${mode.Ki_min}–${mode.Ki_max}` },
      { label: 'Kd',   count: mode.Kd_steps,
        range: `${mode.Kd_min}–${mode.Kd_max}` },
      { label: 'Wind', count: mode.wind_configs.length,
        range: mode.wind_configs.map(w => w.disturbance_type).join(', ') },
    ];

    const paramsEl = document.getElementById('dg-config-params');
    if (paramsEl) {
      paramsEl.innerHTML = paramRows.map(r => `
        <div class="config-param-row">
          <span class="config-param-label">${r.label}</span>
          <div class="config-param-bar">
            <div class="config-param-fill"
                 style="width:${Math.min(r.count / 10 * 100, 100)}%"></div>
          </div>
          <span class="config-param-count">${r.count} values</span>
          <span class="config-param-range">${r.range}</span>
        </div>`).join('');
    }

    const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setT('dg-preview-total',   total.toLocaleString());
    setT('dg-preview-minutes', est);
    setT('dg-preview-dataset', mode.id);

    const barEl = document.getElementById('dg-preview-bar');
    if (barEl) barEl.style.width = Math.min(est / 60 * 100, 100) + '%';
  }

  // ── Advanced panel (collapsible density sliders) ──────────────
  _bindAdvancedPanel() {
    const toggle = document.getElementById('dg-advanced-toggle');
    const body   = document.getElementById('dg-advanced-body');
    if (!toggle || !body) return;

    toggle.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.textContent = (open ? '▶' : '▼') + ' Customize grid density (optional)';
    });

    // Kp/Ki/Kd density sliders
    ['Kp', 'Ki', 'Kd'].forEach(param => {
      const slider = document.getElementById(`dg-adv-${param.toLowerCase()}-steps`);
      const valEl  = document.getElementById(`dg-adv-${param.toLowerCase()}-val`);
      if (!slider) return;
      slider.addEventListener('input', () => {
        const mode = GENERATOR_MODES[this.selectedMode];
        mode[`${param}_steps`] = +slider.value;
        if (valEl) valEl.textContent = slider.value + ' steps';
        this.renderConfigPreview();
        // Also update mode card quick stats
        document.querySelectorAll('.mode-card').forEach(c => {
          if (c.dataset.mode === this.selectedMode) {
            const m = GENERATOR_MODES[this.selectedMode];
            const statsEl = c.querySelector('.mode-quick-stats');
            if (statsEl) statsEl.innerHTML =
              `<span>~${m.total_tests.toLocaleString()} tests</span><span>|</span><span>~${m.est_minutes} min</span>`;
          }
        });
      });
    });
  }

  // ── Section C: generation ────────────────────────────────────
  async startGeneration() {
    if (this.isGenerating) return;
    const mode = GENERATOR_MODES[this.selectedMode];

    const existing = this.experiments[mode.id];
    if (existing?.has_data) {
      const ok = confirm(
        `Dataset ${mode.id} already has ${existing.row_count.toLocaleString()} rows.\n` +
        `Overwrite with new data?`
      );
      if (!ok) return;
    }

    this.isGenerating = true;
    this.startTime    = Date.now();
    this._updateGenerateButton(true);
    this._setProgress(0, mode.total_tests);
    this._setProgressCurrent('Starting worker...');

    // Delete existing data before generating
    await fetch(`/api/experiments/${mode.id}`, { method: 'DELETE' });

    const config = {
      mode_id:      mode.id,
      L_values:     mode.L_values,
      m_values:     mode.m_values,
      Kp_min:       mode.Kp_min, Kp_max: mode.Kp_max, Kp_steps: mode.Kp_steps,
      Ki_min:       mode.Ki_min, Ki_max: mode.Ki_max, Ki_steps: mode.Ki_steps,
      Kd_min:       mode.Kd_min, Kd_max: mode.Kd_max, Kd_steps: mode.Kd_steps,
      wind_configs: mode.wind_configs,
      b: 1.2, dt: 0.005, max_time: 30.0,
    };

    this.activeWorker = new Worker('/data-generator-worker.js');
    this.activeWorker.postMessage({ type: 'START', config });

    this.activeWorker.onmessage = async (e) => {
      const d = e.data;
      if      (d.type === 'PROGRESS') this._onProgress(d, mode.total_tests);
      else if (d.type === 'COMPLETE') await this._onComplete(d, mode.id, config);
      else if (d.type === 'ERROR')    this._onError(d.message);
    };

    this.activeWorker.onerror = (err) => {
      this._onError(err.message || 'Worker error');
    };
  }

  _onProgress(data, total) {
    this._setProgress(data.done, total);

    const elapsed = (Date.now() - this.startTime) / 1000;
    const eta     = data.done > 0
      ? elapsed / data.done * (total - data.done)
      : 0;

    const etaEl = document.getElementById('dg-progress-eta');
    if (etaEl) etaEl.textContent = `ETA: ~${(eta / 60).toFixed(1)} min`;

    if (data.lastResult) {
      const r = data.lastResult;
      this._setProgressCurrent(
        `L=${r.L}m  m=${r.m}kg  Kp=${r.Kp}  Ki=${r.Ki}  Kd=${r.Kd}  → score=${r.score}`
      );
    }
  }

  async _onComplete(data, datasetId, config) {
    const records = data.records;
    this._setProgressCurrent(`Saving ${records.length.toLocaleString()} rows...`);

    // Save in 500-record chunks to avoid one giant HTTP request
    for (let i = 0; i < records.length; i += this.BATCH_SIZE) {
      const chunk = records.slice(i, i + this.BATCH_SIZE);
      await fetch(`/api/experiments/${datasetId}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk, overwrite: i === 0 }),
      });
      this._setProgressCurrent(
        `Saving... ${Math.min(i + this.BATCH_SIZE, records.length).toLocaleString()} / ${records.length.toLocaleString()} rows`
      );
    }

    // Save generation log
    await fetch(`/api/experiments/${datasetId}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset_name:  datasetId,
        generated_at:  new Date().toISOString(),
        total_tests:   data.done,
        ok_tests:      records.length,
        skipped_tests: data.skipped,
        elapsed_min:   +((Date.now() - this.startTime) / 60000).toFixed(2),
        config,
      }),
    });

    this._setProgress(data.done, data.done);
    this._setProgressCurrent(`Done — ${records.length.toLocaleString()} rows saved.`);
    this.isGenerating = false;
    this.activeWorker = null;
    this._updateGenerateButton(false);

    await this.refreshExperimentsState();
    this.renderDatasetStatusCards();
    this._renderActiveModelBar();

    this.showNotification(
      `Dataset ${datasetId} generated — ${records.length.toLocaleString()} rows OK ` +
      `(${data.skipped} skipped as diverged)`,
      'success'
    );
  }

  _onError(msg) {
    this.isGenerating = false;
    this.activeWorker = null;
    this._updateGenerateButton(false);
    this.showNotification(`Worker error: ${msg}`, 'error');
  }

  stopGeneration() {
    if (this.activeWorker) {
      this.activeWorker.terminate();
      this.activeWorker = null;
    }
    this.isGenerating = false;
    this._updateGenerateButton(false);
    this._setProgressCurrent('Generation stopped.');
  }

  // ── Dataset A/B/C status cards ────────────────────────────────
  async refreshExperimentsState() {
    try {
      const resp = await fetch('/api/experiments');
      if (!resp.ok) return;
      const list = await resp.json();
      this.experiments = {};
      list.forEach(e => { this.experiments[e.name] = e; });
    } catch { /* server may not be ready yet */ }

    try {
      const resp = await fetch('/api/active-experiment');
      if (resp.ok) this.activeConfig = await resp.json();
    } catch { /* server may not be ready yet */ }
  }

  renderDatasetStatusCards() {
    const container = document.getElementById('dg-dataset-cards');
    if (!container) return;

    const entries = [
      { key: 'model_dataset_fallback', label: 'A — FALLBACK', colorClass: 'danger'  },
      { key: 'model_dataset_low',      label: 'B — LOW',      colorClass: 'warning' },
      { key: 'model_dataset_high',     label: 'C — HIGH',     colorClass: 'success' },
      { key: 'model_dataset_manual',   label: 'D — MANUAL',   colorClass: 'manual'  },
      { key: 'model_dataset_auto',     label: 'E — AUTO',     colorClass: 'auto'    },
    ];

    container.innerHTML = entries.map(e => {
      const state    = this.experiments[e.key] || {};
      const hasData  = state.has_data;
      const hasModel = state.has_model;
      const meta     = state.model_meta;

      const dataStatus = hasData
        ? `<span class="status-ok">● Data: ${state.row_count?.toLocaleString()} rows</span>`
        : `<span class="status-none">○ No data</span>`;

      const r2Text = hasModel && meta
        ? `R²=${(meta.avg_r2 ?? 0).toFixed(2)} ${meta.confidence_label ?? ''}`
        : '';
      const modelStatus = hasModel && meta
        ? `<span class="status-ok">✓ Model: ${r2Text}</span>`
        : `<span class="status-none">○ Model: not built</span>`;

      const buildLabel = hasModel ? '🔨 RETRAIN' : '🔨 TRAIN MODEL';
      const buildBtn = hasData
        ? `<button class="btn-sm" onclick="dataGeneratorUI.buildModel('${e.key}', event)">${buildLabel}</button>`
        : '';

      const activateBtn = hasModel
        ? `<button class="btn-sm btn-activate" onclick="dataGeneratorUI.activateExperiment('${e.key}')">✓ ACTIVATE</button>`
        : '';

      const resetBtn = (hasData || hasModel)
        ? `<button class="btn-sm btn-danger" onclick="dataGeneratorUI.resetExperiment('${e.key}')">✕ DELETE</button>`
        : '';

      const confCol = (() => {
        if (!hasModel || !meta) return '<div class="dg-conf-col dg-conf-empty"></div>';
        const avg   = meta.avg_r2 ?? 0;
        const label = meta.confidence_label ?? (window.confidenceLabel ? window.confidenceLabel(avg) : '');
        const color = window.confidenceColor ? window.confidenceColor(avg) : 'var(--accent)';
        const kpR2  = meta.metrics?.Kp?.r2 ?? 0;
        const kiR2  = meta.metrics?.Ki?.r2 ?? 0;
        const kdR2  = meta.metrics?.Kd?.r2 ?? 0;
        const bar = (val, mini = false) => {
          const c = window.confidenceColor ? window.confidenceColor(val) : 'var(--accent)';
          return `<div class="dg-conf-bar-track${mini ? ' mini' : ''}"><div class="dg-conf-bar-fill" style="width:${(val * 100).toFixed(0)}%;background:${c}"></div></div>`;
        };
        const paramRow = (name, val) =>
          `<div class="dg-conf-row">
            <span class="dg-conf-row-name">${name}</span>
            ${bar(val, true)}
            <span class="dg-conf-row-val">${val.toFixed(2)}</span>
          </div>`;
        return `
          <div class="dg-conf-col">
            <div class="dg-conf-row">
              <span class="dg-conf-row-name is-score" style="color:${color}">${avg.toFixed(2)}</span>
              ${bar(avg)}
              <span class="dg-conf-row-label" style="color:${color}">${label}</span>
            </div>
            <div class="dg-conf-sep"></div>
            ${paramRow('Kp', kpR2)}
            ${paramRow('Ki', kiR2)}
            ${paramRow('Kd', kdR2)}
          </div>`;
      })();

      return `
        <div class="dataset-card dataset-card-${e.colorClass}">
          <div class="dataset-card-header">
            <span class="dataset-label">${e.label}</span>
            ${confCol}
            <div class="dataset-card-actions">${buildBtn}${activateBtn}${resetBtn}</div>
          </div>
          <div class="dataset-card-status">${dataStatus}${modelStatus}</div>
        </div>`;
    }).join('');
  }

  async buildModel(datasetId, evt) {
    const btn = evt?.currentTarget ?? evt?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Training...'; }

    const csvPath   = `../data/experiments/${datasetId}/model_data.csv`;
    const outputDir = `../data/experiments/${datasetId}`;

    try {
      const resp = await fetch('/api/ai/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv_path:       csvPath,
          output_dir:     outputDir,
          model_filename: 'model.joblib',
          meta_filename:  'model_metadata.json',
        }),
      });
      const data = await resp.json();
      if (data.status === 'ok') {
        const avgR2 = data.stats?.avg_r2?.toFixed(3) ?? '?';
        this.showNotification(
          `Model built for ${datasetId}: Avg R²=${avgR2}`, 'success'
        );
        await this.refreshExperimentsState();
        this.renderDatasetStatusCards();
        this._renderActiveModelBar();
      } else {
        throw new Error(data.detail || data.error || 'Training failed');
      }
    } catch (err) {
      this.showNotification(`Error: ${err.message}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🔨 TRAIN MODEL'; }
    }
  }

  async activateExperiment(datasetId) {
    try {
      const resp = await fetch(`/api/experiments/${datasetId}/activate`, {
        method: 'POST',
      });
      const data = await resp.json();
      if (data.error) {
        this.showNotification(`Error: ${data.error}`, 'error');
        return;
      }

      // Notify ai-service to swap the in-memory model without a restart
      try {
        await fetch('/api/ai/switch-experiment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ experiment: datasetId }),
        });
      } catch { /* ai-service may not have reloaded yet */ }

      const r2Label = data.avg_r2 != null
        ? `R²=${data.avg_r2.toFixed(2)} ${data.confidence_label ?? ''}`
        : '';
      this.showNotification(`Activated ${datasetId} — ${r2Label}`, 'success');

      await this.refreshExperimentsState();
      this.renderDatasetStatusCards();
      this._renderActiveModelBar();

      // Unlock AI DRIVEN tab if confidence is sufficient
      if ((data.avg_r2 ?? 0) >= 0.50 && typeof window.unlockAIDrivenTab === 'function') {
        window.unlockAIDrivenTab();
      }
    } catch (err) {
      this.showNotification(`Error: ${err.message}`, 'error');
    }
  }

  async resetExperiment(datasetId) {
    if (!confirm(`Delete data and model for ${datasetId}?`)) return;
    await fetch(`/api/experiments/${datasetId}`, { method: 'DELETE' });
    this.showNotification(`${datasetId} reset.`, 'success');
    await this.refreshExperimentsState();
    this.renderDatasetStatusCards();
    this._renderActiveModelBar();
  }

  // ── Helpers ──────────────────────────────────────────────────
  _updateGenerateButton(isRunning) {
    const btn     = document.getElementById('dg-generate-btn');
    const stopBtn = document.getElementById('dg-stop-btn');
    if (btn) {
      btn.disabled    = isRunning;
      btn.textContent = isRunning ? '⏳ Generating...' : '▶ GENERATE MODEL TRAINING DATASET';
    }
    if (stopBtn) stopBtn.style.display = isRunning ? 'inline-block' : 'none';
  }

  _setProgress(done, total) {
    const pct   = total > 0 ? (done / total * 100).toFixed(1) : 0;
    const bar   = document.getElementById('dg-progress-bar');
    const pctEl = document.getElementById('dg-progress-pct');
    const doneEl = document.getElementById('dg-progress-done');
    if (bar)    bar.style.width       = pct + '%';
    if (pctEl)  pctEl.textContent     = pct + '%';
    if (doneEl) doneEl.textContent    = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  }

  _setProgressCurrent(text) {
    const el = document.getElementById('dg-progress-current');
    if (el) el.textContent = text;
  }

  _renderActiveModelBar() {
    const bar = document.getElementById('dg-active-model-bar');
    if (!bar) return;

    const cfg = this.activeConfig;
    if (!cfg?.active_experiment) {
      bar.innerHTML = 'No model active — generate and build a dataset to enable AI DRIVEN.';
      return;
    }

    const r2    = cfg.avg_r2 != null ? cfg.avg_r2.toFixed(2) : '—';
    const label = cfg.confidence_label ?? '';
    // Color the confidence dot by quality level
    const dotColor = label === 'FALLBACK' ? 'var(--red)'
                   : label === 'LOW'      ? 'var(--warn)'
                   : 'var(--accent)';
    bar.innerHTML =
      `<span style="color:${dotColor}">●</span> ` +
      `Active model: <strong>${cfg.active_experiment}</strong>` +
      ` &nbsp;|&nbsp; R²=${r2} ${label}`;
  }

  showNotification(message, type) {
    const el = document.getElementById('dg-notification');
    if (!el) return;
    el.textContent  = message;
    el.className    = `dg-notification dg-notification-${type}`;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 6000);
  }
}

// ── Initialization ──────────────────────────────────────────────────────────
// Must be on window so inline onclick handlers in index.html can reach it
// (ES6 module scope is not global).
const dataGeneratorUI = new DataGeneratorUI();
window.dataGeneratorUI = dataGeneratorUI;

// Called by initTabs() in results-ui.js when the tab is activated
window.initDataGenerator = () => dataGeneratorUI.init();
