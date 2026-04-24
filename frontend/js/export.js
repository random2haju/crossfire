// CSV and PNG export
import { getCy } from './graph.js';

export function exportCSV(params) {
  const qs = buildQueryString(params);
  const url = `/api/export${qs}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'filtered_export.csv';
  a.click();
}

export function exportPNG() {
  const cy = getCy();
  if (!cy) return;
  const blob = cy.png({ output: 'blob', bg: '#12131a', scale: 2 });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ot-traffic-graph.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function buildQueryString(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  const s = p.toString();
  return s ? '?' + s : '';
}
