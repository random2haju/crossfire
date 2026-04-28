import { initGraph, renderGraph, setColorMode, getCy, filterByFlags } from './graph.js';
import { initFilters, getParams, resetFilters, populateFilterOptions } from './filters.js';
import { animation } from './animation.js';
import { exportCSV, exportPNG } from './export.js';
import { initTopologyModal, setKnownDevices, getDevicePosition, wireDragDrop, POSITIONS, pushTopologyToBackend } from './topology.js';
import { initFileManager } from './filemanager.js';

let currentMode = 'host';

// ── Boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initGraph(handleNodeClick, handleEdgeClick);
  initFilters(fetchGraph);
  bindToolbar();
  bindDetailTabs();
  initTopologyModal(async () => {
    // Topology changed — refresh graph with remapped zones
    await fetchGraph(getParams());
    await fetchSummary();
  });
  wireDragDrop();
  // Restore topology to backend (survives server restarts)
  pushTopologyToBackend();
  initFileManager(onDataChanged);

  // Wire empty-state Files button
  document.getElementById('btn-files-empty')?.addEventListener('click', () => {
    document.getElementById('btn-files').click();
  });
});

// ── Toolbar bindings ─────────────────────────────────────────────────
function bindToolbar() {
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
    document.getElementById('speed-control').style.opacity = e.target.checked ? '1' : '0.4';
  });

  // Animation speed slider
  document.getElementById('anim-speed').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    animation.setSpeed(val);
    document.getElementById('anim-speed-val').textContent = val.toFixed(1) + '×';
  });

  // Export
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    exportCSV({ ...getParams(), mode: currentMode });
  });
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);

  // Flag type filter (client-side multi-select)
  document.getElementById('f-flag-types')?.addEventListener('change', () => {
    const sel = Array.from(document.getElementById('f-flag-types').selectedOptions).map(o => o.value);
    const result = filterByFlags(sel);
    const el = document.getElementById('unusual-flag-summary');
    if (el) el.textContent = sel.length
      ? `${result.visibleCount} edge${result.visibleCount !== 1 ? 's' : ''} shown`
      : '';
  });
}

// ── Detail tabs ──────────────────────────────────────────────────────
function bindDetailTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabEl = document.getElementById(`tab-${tab}`);
      tabEl.classList.remove('hidden');
      tabEl.classList.add('active');
      if (tab === 'insights') fetchSummary();
      if (tab === 'hunting') updateHuntingTab();
    });
  });
}

// ── Called by file manager after any add/remove ──────────────────────
async function onDataChanged(meta = {}) {
  // Fetch fresh combined metadata
  const res  = await fetch('/api/files');
  const data = await res.json();

  const hasData = (data.total_records || 0) > 0;
  document.getElementById('empty-state').classList.toggle('hidden', hasData);

  // Update dataset badge
  const badge = document.getElementById('dataset-badge');
  if (hasData) {
    badge.textContent = `${(data.files || []).length} file${data.files.length !== 1 ? 's' : ''} · ${(data.total_records || 0).toLocaleString()} records`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  populateFilterOptions(data);
  setKnownDevices(data.devices || []);

  if (hasData) {
    await fetchGraph(getParams());
    await fetchSummary();
  }
}

// ── Graph fetch ──────────────────────────────────────────────────────
async function fetchGraph(params = {}) {
  try {
    const qs = buildQS({ ...params, mode: currentMode });
    const res = await fetch(`/api/graph${qs}`);
    const data = await res.json();
    // Reset flag filter on new data
    const flagSel = document.getElementById('f-flag-types');
    if (flagSel) Array.from(flagSel.options).forEach(o => o.selected = false);
    const flagSummary = document.getElementById('unusual-flag-summary');
    if (flagSummary) flagSummary.textContent = '';
    renderGraph(data);
    updateStatusBar(data);
    if (document.getElementById('tab-insights')?.classList.contains('active')) {
      fetchSummary();
    }
  } catch (err) {
    console.error('Graph fetch error:', err);
  }
  // Outside try/catch so graph render errors don't suppress this
  updateHuntingTab();
}

// ── Summary fetch ────────────────────────────────────────────────────
async function fetchSummary() {
  try {
    const qs = buildQS(getParams());
    const [summaryRes, eventsRes] = await Promise.all([
      fetch(`/api/summary${qs}`),
      fetch(`/api/events${qs}&limit=1`),
    ]);
    const summary = await summaryRes.json();
    const eventsData = await eventsRes.json();
    renderInsights(summary, eventsData);
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
  const flagged = cy?.edges('.flagged').length || 0;
  const flaggedStr = flagged > 0 ? ` · ${flagged} flagged` : '';
  bar.textContent = `${data.record_count} events · ${nodes} nodes · ${edges} edges${flaggedStr}`;
  updateFlagCounts();
}

function updateFlagCounts() {
  const cy = getCy();
  if (!cy) return;
  const counts = {};
  cy.edges().forEach((e) => {
    (e.data('flags') || []).forEach((f) => { counts[f] = (counts[f] || 0) + 1; });
  });
  const sel = document.getElementById('f-flag-types');
  if (!sel) return;
  Array.from(sel.options).forEach((opt) => {
    const n = counts[opt.value] || 0;
    opt.textContent = `${opt.value} (${n})`;
    opt.disabled = n === 0;
    opt.style.color = n > 0 ? '' : 'var(--text-muted)';
  });
}

// ── Hunting tab ──────────────────────────────────────────────────────
function updateHuntingTab() {
  try {
    const el = document.getElementById('hunting-detections');
    if (!el) { console.warn('hunting-detections element not found'); return; }
    const cy = getCy();
    if (!cy) { el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Graph not ready.</p>'; return; }

    const allEdges = cy.edges().length;
    const flaggedEdges = [];
    cy.edges().forEach((e) => {
      const flags = e.data('flags') || [];
      if (flags.length > 0) flaggedEdges.push(e);
    });

    if (allEdges === 0) {
      el.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Load data to see detections.</p>';
      return;
    }
    if (flaggedEdges.length === 0) {
      el.innerHTML = `<p style="font-size:12px;color:var(--text-muted)">No flagged edges among ${allEdges} edge${allEdges !== 1 ? 's' : ''} in current view.</p>`;
      return;
    }

  // Sort: most flags first
  flaggedEdges.sort((a, b) => (b.data('flags') || []).length - (a.data('flags') || []).length);

  el.innerHTML = `
    <h3 style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.06em;margin-bottom:8px">
      Detections (${flaggedEdges.length})
    </h3>
    ${flaggedEdges.map((e) => {
      const d = e.data();
      const flagBadges = (d.flags || []).map(f => `<span class="badge badge-flag" style="font-size:9px;padding:1px 5px">${f}</span>`).join(' ');
      return `
        <div class="hunting-item" data-edge-id="${d.id}" style="
          padding:8px;margin-bottom:6px;border-radius:4px;
          background:var(--surface);border:1px solid var(--border);
          cursor:pointer;transition:border-color .15s
        ">
          <div style="margin-bottom:4px">${flagBadges}</div>
          <div style="font-size:11px;font-family:monospace;color:var(--text-primary)">
            ${d.source} → ${d.target}
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px">
            ${d.count} events · ${d.allow_count} allow / ${d.deny_count} deny
          </div>
        </div>`;
    }).join('')}
  `;

  // Wire click: select edge in graph + switch to Details
  el.querySelectorAll('.hunting-item').forEach((item) => {
    item.addEventListener('click', () => {
      const edge = cy.getElementById(item.dataset.edgeId);
      if (!edge.length) return;
      cy.elements().unselect();
      edge.select();
      cy.animate({ center: { eles: edge }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 300 });
      // Switch to Details tab and populate it
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="details"]').classList.add('active');
      const detailsTab = document.getElementById('tab-details');
      detailsTab.classList.remove('hidden');
      detailsTab.classList.add('active');
      handleEdgeClick(edge.data());
    });
    item.addEventListener('mouseenter', () => { item.style.borderColor = '#ffc107'; });
    item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border)'; });
  });
  } catch (err) {
    console.error('updateHuntingTab error:', err);
    const el = document.getElementById('hunting-detections');
    if (el) el.innerHTML = `<p style="font-size:12px;color:#ef9a9a">Error building detections list — check console.</p>`;
  }
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
  const flags = data.flags || [];
  const flagsHtml = flags.length ? `
    <div class="detail-section">
      <h4 class="flag-section-header"><span class="unusual-indicator"></span>Unusual Flags</h4>
      <div class="tag-list">${flags.map(f => `<span class="badge badge-flag">${f}</span>`).join('')}</div>
    </div>` : '';
  const allowPct = data.count > 0 ? Math.round(data.allow_count / data.count * 100) : 0;
  // Resolve firewall boundary context from topology map
  const boundaryHtml = (() => {
    const devices = data.devices || [];
    const positioned = devices
      .map((dev) => {
        const posId = getDevicePosition(dev);
        if (!posId) return null;
        const pos = POSITIONS.find((p) => p.id === posId);
        return pos ? `<div class="detail-kv"><span class="key">${dev}</span><span class="val">${pos.label} boundary</span></div>` : null;
      })
      .filter(Boolean);
    if (!positioned.length) return '';
    return `<div class="detail-section"><h4>Firewall Boundary</h4>${positioned.join('')}</div>`;
  })();

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
    ${flagsHtml}
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
    ${boundaryHtml}
    ${policiesHtml}
  `;
}

// ── Insights rendering ───────────────────────────────────────────────
function renderInsights(data, eventsData = {}) {
  const el = document.getElementById('insights-content');
  if (!el) return;

  const crossZonePairs = Object.entries(data.cross_zone_totals || {});
  const maxCross = Math.max(...crossZonePairs.map(([,v]) => v), 1);

  const events = eventsData.events || [];
  const eventsTotal = eventsData.total ?? null;
  const eventsHtml = `
    <div class="insight-section">
      <h4>Sample Event${eventsTotal !== null ? ` (${eventsTotal} total match filters)` : ''}</h4>
      ${events.length === 0 ? '<p style="color:var(--text-muted);font-size:12px">No events match current filters.</p>' : `
      <div style="overflow-x:auto;max-height:280px;overflow-y:auto">
        <table class="insight-table" style="font-size:10px;white-space:nowrap;width:100%">
          <thead><tr>
            <th>Time</th><th>Src IP</th><th>Dst IP</th>
            <th>Src Zone</th><th>Dst Zone</th><th>Action</th>
            <th>Proto</th><th>Port</th><th>Bytes</th><th>Device</th>
          </tr></thead>
          <tbody>
            ${events.map(r => `<tr>
              <td>${r.timestamp ? String(r.timestamp).slice(0, 19) : '-'}</td>
              <td>${r.src_ip || '-'}</td><td>${r.dst_ip || '-'}</td>
              <td>${r.src_zone || '-'}</td><td>${r.dst_zone || '-'}</td>
              <td><span class="badge badge-${r.action || 'unknown'}" style="font-size:9px;padding:1px 5px">${r.action || '-'}</span></td>
              <td>${r.protocol || '-'}</td><td>${r.dst_port != null ? r.dst_port : '-'}</td>
              <td>${r.bytes != null ? r.bytes : '-'}</td>
              <td>${r.device_name || '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </div>`;

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

    ${eventsHtml}
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
