// RAF-based moving-dash animation for directional edge flow indication
let _cy = null;
let _rafId = null;
let _enabled = true;
let _offset = 0;

export const animation = {
  init(cy) {
    _cy = cy;
  },

  setEnabled(val) {
    _enabled = val;
    if (!_enabled) {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      // Reset dash offset
      if (_cy) _cy.edges().style('line-dash-offset', 0);
    } else {
      this.restart();
    }
  },

  restart() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_enabled && _cy) tick();
  },

  stop() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  },
};

let lastTime = 0;
function tick(timestamp = 0) {
  if (!_cy) return;
  // ~30fps target
  if (timestamp - lastTime > 33) {
    lastTime = timestamp;
    _offset = (_offset + 3) % 9999;
    // Apply to non-zone edges only
    _cy.edges().style('line-dash-offset', -_offset);
  }
  _rafId = requestAnimationFrame(tick);
}
