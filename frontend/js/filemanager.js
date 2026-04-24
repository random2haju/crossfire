// Multi-file manager: upload, list, remove individual files
let _onDataChanged = null;

export function initFileManager(onDataChanged) {
  _onDataChanged = onDataChanged;

  document.getElementById('btn-files').addEventListener('click', openModal);
  document.getElementById('fm-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'fm-overlay') closeModal();
  });
  document.getElementById('fm-close').addEventListener('click', closeModal);
  document.getElementById('fm-add-btn').addEventListener('click', () => {
    document.getElementById('fm-file-input').click();
  });
  document.getElementById('fm-file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadFiles(files);
    e.target.value = '';
  });
  document.getElementById('fm-clear-btn').addEventListener('click', clearAll);

  // Also keep the legacy Import CSV button working
  document.getElementById('file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadFiles(files);
    e.target.value = '';
  });
}

function openModal() {
  refreshList();
  document.getElementById('fm-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('fm-overlay').classList.add('hidden');
}

// ── Upload ────────────────────────────────────────────────────────────
async function uploadFiles(files) {
  const progress = document.getElementById('fm-progress');
  const bar      = document.getElementById('fm-progress-bar');
  const label    = document.getElementById('fm-progress-label');

  progress.classList.remove('hidden');
  document.getElementById('fm-overlay').classList.remove('hidden');

  let done = 0;
  const errors = [];

  for (const file of files) {
    label.textContent = `Uploading ${done + 1} / ${files.length}: ${file.name}`;
    bar.style.width   = `${Math.round((done / files.length) * 100)}%`;

    try {
      const form = new FormData();
      form.append('file', file);
      const res  = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Upload failed');
      _onDataChanged?.(data);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
    done++;
  }

  bar.style.width = '100%';
  label.textContent = errors.length
    ? `Done with ${errors.length} error(s): ${errors.join('; ')}`
    : `Done — ${done} file${done > 1 ? 's' : ''} loaded`;

  setTimeout(() => {
    progress.classList.add('hidden');
    bar.style.width = '0%';
  }, 2000);

  refreshList();
}

// ── File list ─────────────────────────────────────────────────────────
async function refreshList() {
  const res  = await fetch('/api/files');
  const data = await res.json();
  renderList(data);
}

function renderList(data) {
  const { files = [], total_records = 0 } = data;
  const list  = document.getElementById('fm-file-list');
  const empty = document.getElementById('fm-empty');
  const total = document.getElementById('fm-total');

  total.textContent = `${files.length} file${files.length !== 1 ? 's' : ''} · ${fmtNum(total_records)} total records`;

  if (!files.length) {
    list.innerHTML  = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = files.map((f) => `
    <div class="fm-row" data-id="${f.file_id}">
      <div class="fm-row-main">
        <div class="fm-filename" title="${f.name}">${f.name}</div>
        <div class="fm-meta">
          <span class="fm-badge">${fmtNum(f.record_count)} records</span>
          ${f.time_min ? `<span class="fm-badge">${fmtDate(f.time_min)} – ${fmtDate(f.time_max)}</span>` : ''}
          ${(f.devices || []).map(d => `<span class="fm-badge fm-badge-device">${d}</span>`).join('')}
        </div>
      </div>
      <button class="fm-remove-btn" data-id="${f.file_id}" title="Remove this file">&#10005;</button>
    </div>
  `).join('');

  list.querySelectorAll('.fm-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeFile(btn.dataset.id));
  });
}

async function removeFile(fileId) {
  const res  = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
  const data = await res.json();
  renderList({ files: await getFileList(), ...data });
  _onDataChanged?.(data);
}

async function clearAll() {
  if (!confirm('Remove all loaded files?')) return;
  await fetch('/api/files/clear', { method: 'POST' });
  refreshList();
  _onDataChanged?.({});
}

async function getFileList() {
  const res = await fetch('/api/files');
  const d   = await res.json();
  return d.files || [];
}

// ── Helpers ───────────────────────────────────────────────────────────
function fmtNum(n) {
  if (!n) return '0';
  return n.toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD
}
