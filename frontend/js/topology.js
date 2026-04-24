// Topology builder: maps device names to firewall boundary positions
// Persisted to localStorage so the mapping survives page reloads.

const STORAGE_KEY = 'crossfire_topology_v1';

export const POSITIONS = [
  { id: 'wan-it',  label: 'WAN ↔ IT',  from: 'WAN', to: 'IT'  },
  { id: 'it-dmz',  label: 'IT ↔ DMZ',  from: 'IT',  to: 'DMZ' },
  { id: 'wan-dmz', label: 'WAN ↔ DMZ', from: 'WAN', to: 'DMZ' },
  { id: 'dmz-ot',  label: 'DMZ ↔ OT',  from: 'DMZ', to: 'OT'  },
];

// { deviceName: positionId }
let _map = {};
let _knownDevices = [];
let _onChange = null;

// ── Persistence ───────────────────────────────────────────────────
export function loadTopology() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _map = raw ? JSON.parse(raw) : {};
  } catch { _map = {}; }
  return _map;
}

function saveTopology() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_map));
  _onChange?.(_map);
}

// ── Public API ────────────────────────────────────────────────────
export function getDevicePosition(deviceName) {
  return _map[deviceName] || null;
}

export function getTopologyMap() { return { ..._map }; }

export function setKnownDevices(devices) {
  _knownDevices = devices;
}

// ── Modal init ────────────────────────────────────────────────────
export function initTopologyModal(onChange) {
  _onChange = onChange;
  loadTopology();

  document.getElementById('btn-topology').addEventListener('click', openModal);
  document.getElementById('topo-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'topo-overlay') closeModal();
  });
  document.getElementById('topo-close').addEventListener('click', closeModal);
  document.getElementById('topo-save').addEventListener('click', () => {
    saveTopology();
    closeModal();
    showToast('Topology saved');
  });
  document.getElementById('topo-clear').addEventListener('click', () => {
    _map = {};
    renderModal();
  });
}

function openModal() {
  renderModal();
  document.getElementById('topo-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('topo-overlay').classList.add('hidden');
}

// ── Rendering ─────────────────────────────────────────────────────
function renderModal() {
  renderPositions();
  renderUnassigned();
}

function renderPositions() {
  POSITIONS.forEach((pos) => {
    const zone = document.getElementById(`topo-pos-${pos.id}`);
    if (!zone) return;
    zone.innerHTML = '';
    const assigned = Object.entries(_map)
      .filter(([, p]) => p === pos.id)
      .map(([dev]) => dev);

    assigned.forEach((dev) => {
      zone.appendChild(makeDeviceChip(dev, true));
    });
  });
}

function renderUnassigned() {
  const pool = document.getElementById('topo-unassigned');
  if (!pool) return;
  pool.innerHTML = '';
  const assignedSet = new Set(Object.keys(_map));
  const unassigned = _knownDevices.filter((d) => !assignedSet.has(d));

  if (!unassigned.length) {
    pool.innerHTML = '<span class="topo-empty">All devices assigned</span>';
    return;
  }
  unassigned.forEach((dev) => pool.appendChild(makeDeviceChip(dev, false)));
}

function makeDeviceChip(name, assigned) {
  const chip = document.createElement('div');
  chip.className = 'topo-chip';
  chip.draggable = true;
  chip.textContent = name;
  chip.dataset.device = name;

  if (assigned) {
    const rm = document.createElement('span');
    rm.className = 'topo-chip-rm';
    rm.textContent = '×';
    rm.title = 'Unassign';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      delete _map[name];
      renderModal();
    });
    chip.appendChild(rm);
  }

  chip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', name);
    chip.classList.add('dragging');
  });
  chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
  return chip;
}

// Drop zones are wired in buildTopologyHTML via event delegation
export function wireDragDrop() {
  document.querySelectorAll('.topo-dropzone').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const dev = e.dataTransfer.getData('text/plain');
      if (!dev) return;
      _map[dev] = zone.dataset.pos;
      renderModal();
    });
  });

  // Unassigned pool as a drop target (to remove assignment)
  const pool = document.getElementById('topo-unassigned');
  pool?.addEventListener('dragover', (e) => { e.preventDefault(); pool.classList.add('drag-over'); });
  pool?.addEventListener('dragleave', () => pool.classList.remove('drag-over'));
  pool?.addEventListener('drop', (e) => {
    e.preventDefault();
    pool.classList.remove('drag-over');
    const dev = e.dataTransfer.getData('text/plain');
    if (dev) { delete _map[dev]; renderModal(); }
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast toast-success';
  setTimeout(() => el.classList.add('hidden'), 3000);
}
