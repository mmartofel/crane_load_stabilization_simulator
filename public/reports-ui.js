// ============================================================
// reports-ui.js — REPORTS tab: session list, charts, tables
// ============================================================

class ReportsUI {
  constructor() {
    this.sessions              = [];
    this.activeSessionId       = null;
    this.selectedForComparison = new Set();
  }

  async loadSessions() {
    try {
      const resp = await fetch('/api/sessions');
      this.sessions = await resp.json();
    } catch {
      this.sessions = [];
    }
    this.renderSessionList();
    if (this.sessions.length > 0) {
      this.showSession(this.sessions[0].session_id);
    } else {
      this._showEmpty();
    }
  }

  renderSessionList() {
    const el = document.getElementById('reports-session-list');
    if (!el) return;
    if (this.sessions.length === 0) {
      el.innerHTML = '<div class="rep-empty">No sessions yet.<br>Run an AI DRIVEN scenario to generate reports.</div>';
      return;
    }
    el.innerHTML = this.sessions.map(s => {
      const date = new Date(s.timestamp).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const avg = s.metrics?.avg_theta_deg?.toFixed(2) ?? '—';
      const max = s.metrics?.max_theta_deg?.toFixed(2) ?? '—';
      const upd = s.metrics?.ai_updates ?? '—';
      const isActive = s.session_id === this.activeSessionId;
      const isSelected = this.selectedForComparison.has(s.session_id);
      return `<div class="rep-session-card ${isActive ? 'active' : ''}" data-id="${s.session_id}">
        <div class="rep-session-header">
          <input type="checkbox" class="rep-compare-check" data-id="${s.session_id}" ${isSelected ? 'checked' : ''}>
          <span class="rep-session-date">${date}</span>
        </div>
        <div class="rep-session-meta">Avg θ: ${avg}°  Max θ: ${max}°  Updates: ${upd}</div>
        <button class="rep-btn-view pid-btn pid-btn-primary" data-id="${s.session_id}">View report</button>
      </div>`;
    }).join('');

    // Event delegation
    el.querySelectorAll('.rep-btn-view').forEach(btn => {
      btn.addEventListener('click', () => this.showSession(btn.dataset.id));
    });
    el.querySelectorAll('.rep-compare-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        if (e.target.checked) this.selectedForComparison.add(e.target.dataset.id);
        else this.selectedForComparison.delete(e.target.dataset.id);
        this._updateCompareBtn();
      });
    });
  }

  _updateCompareBtn() {
    const btn = document.getElementById('rep-btn-compare');
    if (!btn) return;
    btn.disabled = this.selectedForComparison.size < 2;
    btn.textContent = `Compare selected (${this.selectedForComparison.size})`;
  }

  showSession(sessionId) {
    const session = this.sessions.find(s => s.session_id === sessionId);
    if (!session) return;
    this.activeSessionId = sessionId;
    this.renderSessionList(); // re-render to update active state

    // Show detail panel, hide comparison
    const detail  = document.getElementById('reports-detail');
    const compare = document.getElementById('reports-compare');
    if (detail)  detail.style.display = '';
    if (compare) compare.style.display = 'none';

    this.renderSummaryCards(session);
    this.renderThetaChart(session);
    this.renderParamsChart(session);
    this.renderPhaseTable(session);
    this.renderDecisionTable(session);

    // Session title
    const titleEl = document.getElementById('rep-session-title');
    if (titleEl) {
      titleEl.textContent = `Session: ${new Date(session.timestamp).toLocaleString('en-GB')}`;
    }

    // Bind export buttons
    document.getElementById('rep-export-csv')?.addEventListener('click', () => this.exportCSV(session));
    document.getElementById('rep-export-json')?.addEventListener('click', () => this.exportJSON(session));
  }

  renderSummaryCards(session) {
    const m   = session.metrics || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('rep-card-avg',     (m.avg_theta_deg ?? '—') + '°');
    set('rep-card-max',     (m.max_theta_deg ?? '—') + '°');
    set('rep-card-updates', m.ai_updates ?? '—');
    set('rep-card-forced',  m.forced_updates ?? '—');
  }

  renderThetaChart(session) {
    const canvas = document.getElementById('rep-theta-chart');
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 600;
    const H = canvas.height = 220;
    const ts = session.timeseries || [];
    if (ts.length < 2) {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px monospace';
      ctx.fillText('No time series data', W/2 - 60, H/2);
      return;
    }

    const pad  = { l: 36, r: 12, t: 16, b: 28 };
    const iW   = W - pad.l - pad.r;
    const iH   = H - pad.t - pad.b;
    const maxT = 360;
    const maxDeg = Math.max(20, ...ts.map(p => p.theta));

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // Phase backgrounds
    const scenario = window.AI_SCENARIO;
    if (scenario) {
      scenario.phases.forEach(phase => {
        const x1 = pad.l + (phase.t_start / maxT) * iW;
        const x2 = pad.l + (phase.t_end   / maxT) * iW;
        ctx.fillStyle = phase.color + '18';
        ctx.fillRect(x1, pad.t, x2 - x1, iH);
      });
    }

    // 15° warning line
    const y15 = pad.t + iH * (1 - 15 / maxDeg);
    ctx.beginPath();
    ctx.moveTo(pad.l, y15);
    ctx.lineTo(W - pad.r, y15);
    ctx.strokeStyle = '#ff444466';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Grid lines
    ctx.strokeStyle = '#2a3441';
    ctx.lineWidth = 0.5;
    [5, 10, 15, 20].forEach(deg => {
      if (deg > maxDeg) return;
      const y = pad.t + iH * (1 - deg / maxDeg);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(W - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = '#3a4a5a';
      ctx.font = '9px monospace';
      ctx.fillText(`${deg}°`, 2, y + 3);
    });

    // Theta curve (AI)
    ctx.beginPath();
    ts.forEach((p, i) => {
      const x = pad.l + (p.t / maxT) * iW;
      const y = pad.t + iH * (1 - Math.min(p.theta, maxDeg) / maxDeg);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Event markers (forced AI decisions)
    const decisions = session.ai_decisions || [];
    decisions.filter(d => d.forced).forEach(d => {
      const x = pad.l + (d.t / maxT) * iW;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + iH);
      ctx.strokeStyle = '#ff9d0088';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff9d00';
      ctx.font = '9px monospace';
      ctx.fillText('⚡', x - 4, pad.t + 10);
    });

    // X axis labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    [0, 60, 120, 180, 240, 300, 360].forEach(sec => {
      const x = pad.l + (sec / maxT) * iW;
      const m = Math.floor(sec / 60);
      ctx.fillText(`${m}:00`, x - 8, H - 6);
    });

    // Legend
    ctx.fillStyle = '#00d4aa';
    ctx.fillRect(pad.l, 4, 16, 4);
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    ctx.fillText('AI controlled θ(t)', pad.l + 20, 10);
  }

  renderParamsChart(session) {
    const canvas = document.getElementById('rep-params-chart');
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 600;
    const H = canvas.height = 160;
    const ts = session.timeseries || [];

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    if (ts.length < 2) return;

    const pad  = { l: 36, r: 12, t: 16, b: 24 };
    const iW   = W - pad.l - pad.r;
    const iH   = H - pad.t - pad.b;
    const maxT = 360;

    const series = [
      { key: 'Kp', color: '#f07070', max: 25, label: 'Kp' },
      { key: 'Ki', color: '#f0a830', max: 0.5, label: 'Ki' },
      { key: 'Kd', color: '#00d4aa', max: 12, label: 'Kd' }
    ];

    series.forEach(s => {
      ctx.beginPath();
      ts.forEach((p, i) => {
        const x = pad.l + (p.t / maxT) * iW;
        const y = pad.t + iH * (1 - Math.min(p[s.key] || 0, s.max) / s.max);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Forced update markers
    const decisions = session.ai_decisions || [];
    decisions.filter(d => d.forced).forEach(d => {
      const x = pad.l + (d.t / maxT) * iW;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + iH);
      ctx.strokeStyle = '#ff9d0055';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Legend
    let lx = pad.l;
    series.forEach(s => {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, 4, 14, 4);
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px monospace';
      ctx.fillText(s.label, lx + 17, 10);
      lx += 50;
    });

    // X labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '9px monospace';
    [0, 60, 120, 180, 240, 300, 360].forEach(sec => {
      const x = pad.l + (sec / maxT) * iW;
      const m = Math.floor(sec / 60);
      ctx.fillText(`${m}m`, x - 6, H - 6);
    });
  }

  renderPhaseTable(session) {
    const el = document.getElementById('rep-phase-table-body');
    if (!el) return;
    const scenario = window.AI_SCENARIO;
    if (!scenario || !session.timeseries) { el.innerHTML = '<tr><td colspan="4">No data</td></tr>'; return; }

    const ts = session.timeseries;
    const rows = scenario.phases.map(phase => {
      const slice = ts.filter(p => p.t >= phase.t_start && p.t < phase.t_end);
      if (slice.length === 0) return `<tr><td>${phase.label}</td><td>—</td><td>—</td><td>—</td></tr>`;
      const avg = (slice.reduce((a, p) => a + p.theta, 0) / slice.length).toFixed(2);
      const max = Math.max(...slice.map(p => p.theta)).toFixed(2);
      const dec = (session.ai_decisions || []).filter(d =>
        d.t >= phase.t_start && d.t < phase.t_end).length;
      return `<tr>
        <td><span style="color:${phase.color}">■</span> ${phase.label}</td>
        <td>${avg}°</td>
        <td>${max}°</td>
        <td>${dec}</td>
      </tr>`;
    });
    el.innerHTML = rows.join('');
  }

  renderDecisionTable(session) {
    const el = document.getElementById('rep-decision-table-body');
    if (!el) return;
    const decisions = session.ai_decisions || [];
    if (decisions.length === 0) {
      el.innerHTML = '<tr><td colspan="5">No decisions</td></tr>';
      return;
    }
    el.innerHTML = decisions.map(d => {
      const t = this._fmt(d.t);
      const icon = d.forced ? '⚡' : d.fallback ? '⚠' : '→';
      const deltaKp = d.prevKp != null ? `${d.prevKp?.toFixed(2)}→${d.Kp.toFixed(2)}` : d.Kp.toFixed(2);
      return `<tr class="${d.forced ? 'rep-forced-row' : ''}">
        <td>${t}</td>
        <td>${icon} ${deltaKp}</td>
        <td>${d.Ki?.toFixed(3) ?? '—'}</td>
        <td>${d.Kd?.toFixed(2) ?? '—'}</td>
        <td>${(d.reason || '').replace(/_/g, ' ')}</td>
      </tr>`;
    }).join('');
  }

  exportCSV(session) {
    const decisions = session.ai_decisions || [];
    const lines = [
      ['time_s', 'Kp', 'Ki', 'Kd', 'prevKp', 'prevKi', 'prevKd',
       'reason', 'forced', 'confidence'].join(','),
      ...decisions.map(d => [
        d.t, d.Kp, d.Ki, d.Kd, d.prevKp || '', d.prevKi || '', d.prevKd || '',
        d.reason || '', d.forced ? 1 : 0, d.confidence || 0
      ].join(','))
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ai_session_${session.session_id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  exportJSON(session) {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `ai_session_${session.session_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  showComparison() {
    const selected = this.sessions.filter(s =>
      this.selectedForComparison.has(s.session_id));
    if (selected.length < 2) return;

    const detail  = document.getElementById('reports-detail');
    const compare = document.getElementById('reports-compare');
    if (detail)  detail.style.display = 'none';
    if (compare) compare.style.display = '';

    this._renderCompareChart(selected);
    this._renderCompareTable(selected);
  }

  _renderCompareChart(sessions) {
    const canvas = document.getElementById('rep-compare-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 500;
    const H = canvas.height = 180;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const colors = ['#00d4aa', '#f0a830', '#e05555', '#7b9fe0'];
    const pad    = { l: 12, r: 12, t: 24, b: 24 };
    const iW     = W - pad.l - pad.r;
    const iH     = H - pad.t - pad.b;
    const barW   = Math.min(80, iW / sessions.length - 12);
    const maxAvg = Math.max(...sessions.map(s => s.metrics?.avg_theta_deg || 0), 5);

    sessions.forEach((s, i) => {
      const avg  = s.metrics?.avg_theta_deg || 0;
      const bH   = (avg / maxAvg) * iH;
      const bx   = pad.l + i * (iW / sessions.length) + (iW / sessions.length - barW) / 2;
      const by   = pad.t + iH - bH;
      ctx.fillStyle = colors[i % colors.length] + 'aa';
      ctx.fillRect(bx, by, barW, bH);
      ctx.fillStyle = colors[i % colors.length];
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${avg.toFixed(2)}°`, bx + barW / 2, by - 4);
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px monospace';
      const date = new Date(s.timestamp).toLocaleDateString('en-GB');
      ctx.fillText(date, bx + barW / 2, H - 6);
    });
    ctx.textAlign = 'left';
  }

  _renderCompareTable(sessions) {
    const el = document.getElementById('rep-compare-table-body');
    if (!el) return;
    const cols = ['avg_theta_deg', 'max_theta_deg', 'ai_updates', 'forced_updates'];
    const labels = ['Avg θ [°]', 'Max θ [°]', 'AI updates', 'Forced'];
    const rows = labels.map((label, ci) => {
      const vals = sessions.map(s => {
        const v = s.metrics?.[cols[ci]];
        return v != null ? (+v).toFixed(ci < 2 ? 2 : 0) : '—';
      });
      return `<tr><td class="rep-compare-label">${label}</td>${vals.map(v => `<td>${v}</td>`).join('')}</tr>`;
    });
    el.innerHTML = rows.join('');

    // Header
    const head = document.getElementById('rep-compare-table-head');
    if (head) {
      head.innerHTML = `<tr><th>Metric</th>${sessions.map(s =>
        `<th>${new Date(s.timestamp).toLocaleDateString('en-GB')}</th>`).join('')}</tr>`;
    }
  }

  _fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _showEmpty() {
    const detail = document.getElementById('reports-detail');
    if (detail) detail.innerHTML = `
      <div class="rep-empty-detail">
        <div style="font-size:32px;margin-bottom:16px">📋</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:8px">No sessions yet</div>
        <div style="color:var(--text-dim)">Run an AI DRIVEN scenario to generate reports.</div>
      </div>`;
  }
}

// ============================================================
// Module init
// ============================================================

const reportsUI = new ReportsUI();

window.addEventListener('reports-tab-activated', () => {
  reportsUI.loadSessions();
});

// Wire compare button
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rep-btn-compare')?.addEventListener('click', () => {
    reportsUI.showComparison();
    document.getElementById('rep-btn-back')?.style && (document.getElementById('rep-btn-back').style.display = '');
  });
  document.getElementById('rep-btn-back')?.addEventListener('click', () => {
    if (reportsUI.activeSessionId) reportsUI.showSession(reportsUI.activeSessionId);
    else reportsUI._showEmpty();
    document.getElementById('rep-btn-back').style.display = 'none';
  });
  document.getElementById('rep-btn-back-compare')?.addEventListener('click', () => {
    if (reportsUI.activeSessionId) reportsUI.showSession(reportsUI.activeSessionId);
    else reportsUI._showEmpty();
  });
});
