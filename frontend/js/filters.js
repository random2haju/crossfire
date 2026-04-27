// Filter form management and debounced API calls
let _onFilter = null;
let _debounceTimer = null;

export function initFilters(onFilterChange) {
  _onFilter = onFilterChange;

  const textInputIds = ['f-src-ip', 'f-dst-ip', 'f-device'];
  textInputIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => debounce());
  });

  const immediateIds = ['f-src-zone', 'f-dst-zone', 'f-protocol', 'f-action', 'f-cross-zone-pair'];
  immediateIds.forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => trigger());
  });

  document.getElementById('f-dst-port')?.addEventListener('change', () => trigger());
  document.getElementById('f-subnet-mask')?.addEventListener('change', () => trigger());
  document.getElementById('chk-cross-zone')?.addEventListener('change', () => trigger());
  document.getElementById('btn-set-time-range')?.addEventListener('click', () => trigger());
}

function debounce() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(trigger, 300);
}

function trigger() {
  _onFilter?.(getParams());
}

export function getParams() {
  const srcZoneEl = document.getElementById('f-src-zone');
  const dstZoneEl = document.getElementById('f-dst-zone');
  const crossZonePair = document.getElementById('f-cross-zone-pair')?.value || '';

  // Cross-zone pair shortcut overrides individual zone selects
  let src_zone = '';
  let dst_zone = '';
  if (crossZonePair) {
    const [s, d] = crossZonePair.split(',');
    src_zone = s;
    dst_zone = d;
  } else {
    src_zone = getMultiSelectValues(srcZoneEl).join(',');
    dst_zone = getMultiSelectValues(dstZoneEl).join(',');
  }

  return {
    src_zone: src_zone || undefined,
    dst_zone: dst_zone || undefined,
    src_ip:   document.getElementById('f-src-ip')?.value.trim() || undefined,
    dst_ip:   document.getElementById('f-dst-ip')?.value.trim() || undefined,
    protocol: document.getElementById('f-protocol')?.value || undefined,
    dst_port: document.getElementById('f-dst-port')?.value || undefined,
    action:   document.getElementById('f-action')?.value || undefined,
    device_name: document.getElementById('f-device')?.value.trim() || undefined,
    subnet_mask: parseInt(document.getElementById('f-subnet-mask')?.value || '24'),
    cross_zone_only: document.getElementById('chk-cross-zone')?.checked || false,
    time_start: formatDateTime(document.getElementById('f-time-start')?.value),
    time_end:   formatDateTime(document.getElementById('f-time-end')?.value),
  };
}

function getMultiSelectValues(el) {
  if (!el) return [];
  return Array.from(el.selectedOptions)
    .map((o) => o.value)
    .filter((v) => v !== '');
}

function formatDateTime(val) {
  if (!val) return undefined;
  // datetime-local gives "YYYY-MM-DDTHH:MM", convert to ISO
  return val.replace('T', ' ') + ':00';
}

export function resetFilters() {
  ['f-src-ip', 'f-dst-ip', 'f-device', 'f-dst-port', 'f-time-start', 'f-time-end'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['f-src-zone', 'f-dst-zone', 'f-protocol', 'f-action', 'f-cross-zone-pair'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; Array.from(el.options).forEach(o => o.selected = false); }
  });
  document.getElementById('f-subnet-mask').value = '24';
  document.getElementById('chk-cross-zone').checked = false;
  trigger();
}

export function populateFilterOptions(meta) {
  // Populate protocol dropdown with options from loaded data
  const protoEl = document.getElementById('f-protocol');
  if (!protoEl) return;
  const existingVals = new Set(Array.from(protoEl.options).map(o => o.value));
  const extra = (meta.protocols || []).filter(p => !existingVals.has(p));
  extra.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    protoEl.appendChild(opt);
  });
}
