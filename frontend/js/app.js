import { initGraph, renderGraph, setColorMode, getCy } from './graph.js';
import { initFilters, getParams, resetFilters, populateFilterOptions } from './filters.js';
import { animation } from './animation.js';
import { exportCSV, exportPNG } from './export.js';

let currentMode = 'host';

// ── Boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGraph(handleNodeClick, handleEdgeClick);
  initFilters(fetchGraph);
  bindToolbar();
  bindDetailTabs();
});

// ── Toolbar bindings ─────────────────────────────────────────────────
function bindToolbar() {
  // File import
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  });

  // Reset
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    resetFilters();
  });

  // Mode buttons
  document.querySelectorAll('#mode-group .btn-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mode-group .btn-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      fetchGraph(getParams());
    });
  });

  // Color mode buttons
  document.querySelectorAll('#color-group .btn-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#color-group .btn-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setColorMode(btn.dataset.color);
    });
  });

  // Animation toggle
  document.getElementById('chk-animate').addEventListener('change', (e) => {
    animation.setEnabled(e.target.checked);
  });

  // Export
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    exportCSV({ ...getParams(), mode: currentMode });
  });
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);
}

// ── Detail tabs ──────────────────────────────────────────────────────
function bindDetailTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });
}

// ── Upload ───────────────────────────────────────────────────────────
async function handleUpload(file) {
  const form = new FormData();
  form.append('file', file);
  showToast('Uploading…', '');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Upload failed');

    showToast(`Loaded ${data.record_count} records from ${file.name}`, 'success');
    populateFilterOptions(data);
    document.getElementById('empty-state').classList.add('hidden');
    await fetchGraph(getParams());
    await fetchSummary();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Graph fetch ──────────────────────────────────────────────────────
async function fetchGraph(params = {}) {
  try {
    const qs = buildQS({ ...params, mode: currentMode });
    const res = await fetch(`/api/graph${qs}`);
    const data = await res.json();
    renderGraph(data);
    updateStatusBar(data);
  } catch (err) {
    console.error('Graph fetch error:', err);
  }
}

// ── Summary fetch ────────────────────────────────────────────────────
async function fetchSummary() {
  try {
    const res = await fetch('/api/summary');
    const data = await res.json();
    renderInsights(data);
  } catch (err) {
    console.error('Summary fetch error:', err);
  }
}

// ── Status bar ───────────────────────────────────────────────────────
function updateStatusBar(data) {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  const cy = getCy();
  const nodes = cy?.nodes('[?parent]').length || cy?.nodes('[!isZone]').length || 0;
  const edges = cy?.edges().length || 0;
  bar.textContent = `${data.record_count} events · ${nodes} nodes · ${edges} edges`;
}

// ── Click handlers ───────────────────────────────────────────────────
function handleNodeClick(data) {
  const content = document.getElementById('detail-content');
  const placeholder = document.getElementById('detail-placeholder');
  if (!data) {
    content.classList.add('hidden');
    content.innerHTML = '';
    placeholder.classList.remove('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  content.classList.remove('hidden');
  content.innerHTML = `
    <div class="detail-section">
      <h4>Node</h4>
      <div class="detail-kv"><span class="key">IP / ID</span><span class="val">${data.id}</span></div>
      <div class="detail-kv"><span class="key">Zone</span><span class="val">${data.zone}</span></div>
      <div class="detail-kv"><span class="key">Connections</span><span class="val">${data.degree ?? '—'}</span></div>
      <div class="detail-kv"><span class="key">Total bytes</span><span class="val">${fmtBytes(data.bytes_total)}</span></div>
    </div>
  `;
}

function handleEdgeClick(data) {
  const content = document.getElementById('detail-content');
  const placeholder = document.getElementById('detail-placeholder');
  if (!data) {
    content.classList.add('hidden');
    content.innerHTML = '';
    placeholder.classList.remove('hidden');
    return;
  }
  placeholder.classList.add('hidden');
  content.classList.remove('hidden');
  const actionBadge = `<span class="badge badge-${data.action}">${data.action}</span>`;
  const allowPct = data.count > 0 ? Math.round(data.allow_count / data.count * 100) : 0;
  const policiesHtml = (data.policies || []).length ? `
    <div class="detail-section">
      <h4>Firewall Policies</h4>
      ${(data.policies || []).map((name, i) => {
        const id = (data.policyids || [])[i] || '';
        return `<div class="detail-kv">
          <span class="key">${id ? `#${id}` : '—'}</span>
          <span class="val" style="font-size:11px">${name}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  content.innerHTML = `
    <div class="detail-section">
      <h4>Flow</h4>
      <div class="detail-kv"><span class="key">Source</span><span class="val">${data.source}</span></div>
      <div class="detail-kv"><span class="key">Destination</span><span class="val">${data.target}</span></div>
      <div class="detail-kv"><span class="key">Dominant action</span><span class="val">${actionBadge}</span></div>
      <div class="detail-kv"><span class="key">Events</span><span class="val">${data.count}</span></div>
      <div class="detail-kv"><span class="key">Allow / Deny</span><span class="val">${data.allow_count} / ${data.deny_count} (${allowPct}% allowed)</span></div>
      <div class="detail-kv"><span class="key">Total bytes</span><span class="val">${fmtBytes(data.bytes_total)}</span></div>
    </div>
    <div class="detail-section">
      <h4>Services / Protocols</h4>
      <div class="tag-list">${(data.protocols || []).map(p => `<span class="tag">${p}</span>`).join('')}</div>
    </div>
    <div class="detail-section">
      <h4>Destination Ports</h4>
      <div class="tag-list">${(data.ports || []).map(p => `<span class="tag">${p}</span>`).join('')}</div>
    </div>
    ${policiesHtml}
  `;
}

// ── Insights rendering ───────────────────────────────────────────────
function renderInsights(data) {
  const el = document.getElementById('insights-content');
  if (!el) return;

  const crossZonePairs = Object.entries(data.cross_zone_totals || {});
  const maxCross = Math.max(...crossZonePairs.map(([,v]) => v), 1);

  el.innerHTML = `
    <div class="insight-section">
      <h4>Top 10 Talkers (by bytes)</h4>
      <table class="insight-table">
        ${(data.top_talkers || []).map(r =>
          `<tr><td>${r.src_ip}</td><td>${fmtBytes(r.total_bytes)}</td></tr>`
        ).join('')}
      </table>
    </div>

    <div class="insight-section">
      <h4>Top 10 Edges (by events)</h4>
      <table class="insight-table">
        ${(data.top_edges || []).map(r =>
          `<tr><td>${r.src_ip} → ${r.dst_ip}</td><td>${r.count}</td></tr>`
        ).join('')}
      </table>
    </div>

    <div class="insight-section">
      <h4>Top 10 Denied Flows</h4>
      <table class="insight-table">
        ${(data.top_denied || []).map(r =>
          `<tr><td>${r.src_ip} → ${r.dst_ip}:${r.dst_port} ${r.protocol}</td><td>${r.count}</td></tr>`
        ).join('')}
      </table>
    </div>

    <div class="insight-section">
      <h4>Top Destination Ports</h4>
      <table class="insight-table">
        ${(data.top_dst_ports || []).map(r =>
          `<tr><td>${r.dst_port} / ${r.protocol}</td><td>${r.count}</td></tr>`
        ).join('')}
      </table>
    </div>

    <div class="insight-section">
      <h4>Cross-Zone Traffic</h4>
      ${crossZonePairs.map(([label, count]) => `
        <div class="zone-bar">
          <span class="zone-bar-label">${label}</span>
          <div class="zone-bar-fill" style="width:${Math.round(count/maxCross*120)}px"></div>
          <span class="zone-bar-count">${count}</span>
        </div>
      `).join('')}
    </div>

    ${data.new_paths?.length ? `
    <div class="insight-section">
      <h4>New Paths (late in dataset)</h4>
      <table class="insight-table">
        ${data.new_paths.map(r =>
          `<tr><td>${r.src_ip} → ${r.dst_ip}</td><td>${r.count}</td></tr>`
        ).join('')}
      </table>
    </div>` : ''}
  `;
}

// ── Utilities ────────────────────────────────────────────────────────
function buildQS(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v);
  });
  const s = p.toString();
  return s ? '?' + s : '';
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + ' MB';
  if (n > 1_000)     return (n / 1_000).toFixed(1) + ' KB';
  return n + ' B';
}

let _toastTimer = null;
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}
