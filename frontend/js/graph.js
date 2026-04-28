// Cytoscape.js graph management
import { animation } from './animation.js';

let cy = null;
let colorMode = 'action'; // 'action' | 'protocol'

// ── Color palettes ──────────────────────────────────────────────────
const ACTION_COLORS = {
  allow:   '#4caf50',
  deny:    '#f44336',
  drop:    '#ff9800',
  unknown: '#9e9e9e',
};

const PROTOCOL_COLORS = {
  // Port-based (CSV logs without service field)
  'TCP/80':    '#2196F3',   // HTTP
  'TCP/443':   '#00BCD4',   // HTTPS
  'TCP/22':    '#FFEB3B',   // SSH
  'TCP/502':   '#FF5722',   // Modbus
  'TCP/102':   '#E91E63',   // S7comm
  'TCP/20000': '#FF9800',   // DNP3
  'TCP/23':    '#FF7043',   // Telnet
  'TCP/3389':  '#AB47BC',   // RDP
  'TCP/8080':  '#42A5F5',   // HTTP-alt
  'TCP/8443':  '#26C6DA',   // HTTPS-alt
  'UDP/514':   '#9C27B0',   // Syslog
  'UDP/123':   '#00E5FF',   // NTP
  'UDP/53':    '#8BC34A',   // DNS
  // FortiGate service names (take priority when matched)
  'HTTP':      '#2196F3',
  'HTTPS':     '#00BCD4',
  'SSH':       '#FFEB3B',
  'RDP':       '#AB47BC',
  'SMB':       '#7986CB',   // indigo — lateral movement risk
  'SAMBA':     '#7986CB',
  'TELNET':    '#FF7043',   // orange-red — dangerous in OT
  'FTP':       '#5C6BC0',
  'DNS':       '#8BC34A',
  'NTP':       '#00E5FF',
  'SYSLOG':    '#9C27B0',
  'SNMP':      '#26A69A',
  'MODBUS':    '#FF5722',
  'DNP3':      '#FF9800',
  'IEC104':    '#F06292',   // OT protocol
  'S7':        '#E91E63',
  'S7COMM':    '#E91E63',
  'OPCUA':     '#EC407A',   // OT protocol
  'EIP':       '#EF5350',   // EtherNet/IP
  'PROFINET':  '#E53935',
  'NETBIOS':   '#78909C',
  'LDAP':      '#90A4AE',
  'KERBEROS':  '#B0BEC5',
  'SMTP':      '#A5D6A7',
  'IMAP':      '#C8E6C9',
  'POP3':      '#DCEDC8',
  'ICMP':      '#607D8B',
  'TCP':       '#64B5F6',
  'UDP':       '#CE93D8',
  'GRE':       '#80CBC4',
  'ESP':       '#FFCC02',
  'unknown':   '#78909C',
};

function resolveProtocolColor(edge) {
  const proto = (edge.data('protocol') || 'unknown').toUpperCase();
  const port  = edge.data('ports')?.[0];
  // Try service name first (e.g. "RDP", "SMB"), then port-qualified (e.g. "TCP/3389"), then generic
  return PROTOCOL_COLORS[proto]
      || PROTOCOL_COLORS[port ? `${proto}/${port}` : '']
      || PROTOCOL_COLORS[proto.split('/')[0]]
      || PROTOCOL_COLORS['unknown'];
}

function edgeColor(edge) {
  if (colorMode === 'protocol') return resolveProtocolColor(edge);
  const action = edge.data('action') || 'unknown';
  return ACTION_COLORS[action] || ACTION_COLORS.unknown;
}

// ── Cytoscape stylesheet ─────────────────────────────────────────────
function buildStylesheet() {
  return [
    // Zone compound containers (host/subnet mode parents)
    {
      selector: 'node[?isZone]',
      style: {
        'shape': 'rectangle',
        'background-opacity': 0.15,
        'border-width': 2,
        'border-style': 'solid',
        'label': 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'font-size': 14,
        'font-weight': 'bold',
        'color': '#aaa',
        'padding': '30px',
        'text-margin-y': -6,
      },
    },
    {
      selector: 'node[zone="IT"][?isZone]',
      style: { 'background-color': '#1a3a5c', 'border-color': '#4a7ab5' },
    },
    {
      selector: 'node[zone="DMZ"][?isZone]',
      style: { 'background-color': '#3a3a1a', 'border-color': '#b5a43a' },
    },
    {
      selector: 'node[zone="OT"][?isZone]',
      style: { 'background-color': '#3a1a1a', 'border-color': '#b54a4a' },
    },
    // Extra / unknown zones — neutral grey
    {
      selector: 'node[?isZone][?isExtra]',
      style: { 'background-color': '#2a2a2a', 'border-color': '#666', 'border-style': 'dashed' },
    },
    // Host/subnet child nodes (inside compound zones)
    {
      selector: 'node:child',
      style: {
        'width': 'data(size)',
        'height': 'data(size)',
        'label': 'data(label)',
        'font-size': 9,
        'color': '#ccc',
        'text-valign': 'bottom',
        'text-margin-y': 3,
        'text-wrap': 'ellipsis',
        'text-max-width': 90,
        'border-width': 1,
        'border-color': 'rgba(255,255,255,0.15)',
      },
    },
    // Zone color for child nodes
    {
      selector: 'node:child[zone="IT"]',
      style: { 'background-color': '#4a7ab5' },
    },
    {
      selector: 'node:child[zone="DMZ"]',
      style: { 'background-color': '#b5a43a' },
    },
    {
      selector: 'node:child[zone="OT"]',
      style: { 'background-color': '#b54a4a' },
    },
    {
      selector: 'node[shape="roundrectangle"]',
      style: { 'shape': 'round-rectangle' },
    },
    // Zone summary nodes (zone-summary mode, no parent, not a container)
    {
      selector: 'node:orphan[!isZone]',
      style: {
        'width': 'data(size)',
        'height': 'data(size)',
        'label': 'data(label)',
        'font-size': 14,
        'color': '#eee',
        'font-weight': 'bold',
        'text-valign': 'center',
        'border-width': 3,
        'border-color': '#fff',
        'border-opacity': 0.3,
      },
    },
    // Zone colors for zone-summary nodes
    {
      selector: 'node:orphan[zone="IT"]',
      style: { 'background-color': '#4a7ab5' },
    },
    {
      selector: 'node:orphan[zone="DMZ"]',
      style: { 'background-color': '#b5a43a' },
    },
    {
      selector: 'node:orphan[zone="OT"]',
      style: { 'background-color': '#b54a4a' },
    },
    // Edges (colors applied programmatically via applyColorMode)
    {
      selector: 'edge',
      style: {
        'width': 'data(weight)',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#9e9e9e',
        'line-color': '#9e9e9e',
        'arrow-scale': 1.2,
        'opacity': 0.85,
        'line-dash-pattern': [6, 3],
        'line-dash-offset': 0,
      },
    },
    // Allow: long dashes look nearly solid but still animate with dash-offset
    {
      selector: 'edge[action="allow"]',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [20, 4] },
    },
    // Deny/drop: short dashes clearly signal blocked traffic
    {
      selector: 'edge[action="deny"], edge[action="drop"]',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 5] },
    },
    // Selection
    {
      selector: ':selected',
      style: {
        'border-width': 3,
        'border-color': '#ffffff',
        'overlay-color': '#ffffff',
        'overlay-opacity': 0.07,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'opacity': 1,
        'width': (ele) => Math.max(ele.data('weight'), 3) + 2,
      },
    },
  ];
}

// ── Init ─────────────────────────────────────────────────────────────
export function initGraph(onNodeClick, onEdgeClick) {
  cy = window.cytoscape({
    container: document.getElementById('cy'),
    style: buildStylesheet(),
    wheelSensitivity: 0.3,
    minZoom: 0.05,
    maxZoom: 4,
  });

  // Tooltip div
  const tooltip = document.createElement('div');
  tooltip.id = 'cy-tooltip';
  document.body.appendChild(tooltip);

  cy.on('mouseover', 'node, edge', (evt) => {
    const el = evt.target;
    const html = buildTooltip(el);
    if (!html) return;
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
  });

  cy.on('mousemove', (evt) => {
    if (tooltip.style.display === 'block') {
      tooltip.style.left = (evt.originalEvent.clientX + 14) + 'px';
      tooltip.style.top  = (evt.originalEvent.clientY + 14) + 'px';
    }
  });

  cy.on('mouseout', 'node, edge', () => {
    tooltip.style.display = 'none';
  });

  cy.on('tap', 'node', (evt) => {
    if (!evt.target.data('isZone')) onNodeClick(evt.target.data());
  });

  cy.on('tap', 'edge', (evt) => {
    onEdgeClick(evt.target.data());
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      onNodeClick(null);
      onEdgeClick(null);
    }
  });

  animation.init(cy);
}

function buildTooltip(el) {
  const d = el.data();
  if (el.isNode() && d.isZone) return '';

  if (el.isNode()) {
    return `
      <div class="tt-label">${d.label}</div>
      <div class="tt-row"><span class="tt-key">Zone</span><span>${d.zone}</span></div>
      <div class="tt-row"><span class="tt-key">Connections</span><span>${d.degree ?? '—'}</span></div>
      <div class="tt-row"><span class="tt-key">Total bytes</span><span>${fmt(d.bytes_total)}</span></div>
    `;
  }

  // Edge
  return `
    <div class="tt-label">${d.source} → ${d.target}</div>
    <div class="tt-row"><span class="tt-key">Events</span><span>${d.count}</span></div>
    <div class="tt-row"><span class="tt-key">Allow / Deny</span><span>${d.allow_count} / ${d.deny_count}</span></div>
    <div class="tt-row"><span class="tt-key">Bytes</span><span>${fmt(d.bytes_total)}</span></div>
    <div class="tt-row"><span class="tt-key">Services</span><span>${(d.protocols||[]).join(', ')}</span></div>
    <div class="tt-row"><span class="tt-key">Ports</span><span>${(d.ports||[]).slice(0,5).join(', ')}${(d.ports||[]).length > 5 ? '…' : ''}</span></div>
    ${(d.policies||[]).length ? `<div class="tt-row"><span class="tt-key">Policies</span><span>${(d.policies||[]).slice(0,2).join(', ')}${(d.policies||[]).length > 2 ? ' …' : ''}</span></div>` : ''}
    ${(d.flags||[]).length ? `<div class="tt-row"><span class="tt-key" style="color:#ffc107">Flags</span><span style="color:#ffd54f">${d.flags.join(', ')}</span></div>` : ''}
  `;
}

function fmt(n) {
  if (!n) return '0';
  if (n > 1_000_000) return (n/1_000_000).toFixed(1) + ' MB';
  if (n > 1_000)     return (n/1_000).toFixed(1) + ' KB';
  return n + ' B';
}

// ── Render ───────────────────────────────────────────────────────────
export function renderGraph(data) {
  if (!cy) return;
  const { nodes = [], edges = [] } = data;

  // Pre-compute edge colors as data field (Cytoscape can't call functions in style mappers directly for dynamic data)
  const elements = [
    ...nodes,
    ...edges.map(e => {
      // We'll apply color via applyColorMode after render
      return e;
    }),
  ];

  cy.startBatch();
  cy.elements().remove();
  cy.add(elements);
  cy.endBatch();

  applyColorMode(colorMode);
  applyFlagClasses();
  runLayout();
  animation.restart();
}

function applyFlagClasses() {
  cy.edges().forEach((edge) => {
    const flags = edge.data('flags') || [];
    if (flags.length > 0) {
      edge.addClass('flagged');
      // Inline style wins over stylesheet — apply amber on top of color mode
      edge.style({ 'line-color': '#ffc107', 'target-arrow-color': '#ffc107' });
    } else {
      edge.removeClass('flagged');
    }
  });
}

export function filterByFlags(selectedFlags) {
  cy.elements().show();
  if (!selectedFlags || selectedFlags.length === 0) {
    return { visibleCount: cy.edges().length };
  }
  cy.startBatch();
  cy.edges().forEach((e) => {
    const flags = e.data('flags') || [];
    const matches = selectedFlags.some(f => flags.includes(f));
    if (!matches) e.hide();
  });
  cy.nodes(':child').forEach((n) => {
    if (n.connectedEdges(':visible').length === 0) n.hide();
  });
  cy.endBatch();
  return { visibleCount: cy.edges(':visible').length };
}

function runLayout() {
  const hasChildren = cy.nodes(':child').length > 0;

  if (!hasChildren) {
    // Zone-summary mode: arrange IT / DMZ / OT horizontally
    const zoneOrder = ['IT', 'DMZ', 'OT'];
    const w = cy.container().offsetWidth;
    const h = cy.container().offsetHeight;
    cy.nodes(':orphan').forEach((n) => {
      const zi = zoneOrder.indexOf(n.data('zone'));
      const idx = zi >= 0 ? zi : cy.nodes(':orphan').indexOf(n);
      n.position({ x: (idx + 0.5) * (w / 3), y: h / 2 });
    });
    cy.fit(undefined, 80);
    return;
  }

  // Host / subnet mode: position child nodes within each zone column
  const w = cy.container().offsetWidth;
  const h = cy.container().offsetHeight;
  const spacing = 75;

  // Collect all zone parent ids in display order (standard first, extra at the end)
  const standardZones = ['it-zone', 'dmz-zone', 'ot-zone'];
  const extraZones = cy.nodes('[?isZone][?isExtra]').map((n) => n.id());
  const allZoneIds = [...standardZones, ...extraZones];
  const totalZones = allZoneIds.filter((id) => cy.getElementById(id).length).length;
  const zoneCols = {};
  let col = 0;
  allZoneIds.forEach((id) => {
    if (cy.getElementById(id).length) {
      zoneCols[id] = (col + 0.5) * (w / totalZones);
      col++;
    }
  });

  cy.startBatch();
  allZoneIds.forEach((zoneId) => {
    const zNode = cy.getElementById(zoneId);
    if (!zNode.length) return;
    const children = zNode.children();
    if (!children.length) return;

    const cx = zoneCols[zoneId];
    const cols = Math.max(1, Math.ceil(Math.sqrt(children.length)));
    const rows  = Math.ceil(children.length / cols);
    const startY = h / 2 - ((rows - 1) * spacing) / 2;

    children.forEach((child, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      child.position({
        x: cx + (col - (cols - 1) / 2) * spacing,
        y: startY + row * spacing,
      });
    });
  });
  cy.endBatch();
  cy.fit(undefined, 40);
}

// ── Color mode ───────────────────────────────────────────────────────
export function setColorMode(mode) {
  colorMode = mode;
  applyColorMode(mode);
  applyFlagClasses();
}

function applyColorMode(mode) {
  colorMode = mode;
  cy.edges().forEach((edge) => {
    const color = mode === 'protocol' ? resolveProtocolColor(edge) : (ACTION_COLORS[edge.data('action')] || ACTION_COLORS.unknown);
    edge.style({
      'line-color': color,
      'target-arrow-color': color,
    });
  });
  updateLegend(mode);
}

function updateLegend(mode) {
  const legend = document.getElementById('legend');
  const title = document.getElementById('legend-title');
  const items = document.getElementById('legend-items');
  if (!legend) return;

  legend.classList.remove('hidden');
  if (mode === 'action') {
    title.textContent = 'Color: Action';
    items.innerHTML = Object.entries(ACTION_COLORS).map(([k, c]) =>
      `<div class="legend-item"><div class="legend-swatch" style="background:${c}"></div>${k}</div>`
    ).join('');
  } else {
    title.textContent = 'Color: Protocol';
    const shown = [
      ['HTTP (80)', '#2196F3'], ['HTTPS (443)', '#00BCD4'], ['SSH (22)', '#FFEB3B'],
      ['Modbus (502)', '#FF5722'], ['S7comm (102)', '#E91E63'], ['DNP3 (20000)', '#FF9800'],
      ['Syslog (514)', '#9C27B0'], ['NTP (123)', '#00E5FF'], ['DNS (53)', '#8BC34A'],
      ['ICMP', '#607D8B'], ['TCP other', '#64B5F6'], ['UDP other', '#CE93D8'],
    ];
    items.innerHTML = shown.map(([k, c]) =>
      `<div class="legend-item"><div class="legend-swatch" style="background:${c}"></div>${k}</div>`
    ).join('');
  }
}

export function getCy() { return cy; }
