// RAF-based moving-dash animation for directional edge flow indication
let _cy      = null;
let _rafId   = null;
let _enabled = true;
let _offset  = 0;
let _speed   = 1; // units per frame; range 0.2 – 5

export const animation = {
  init(cy) {
    _cy = cy;
  },

  setEnabled(val) {
    _enabled = val;
    if (!_enabled) {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      if (_cy) _cy.edges().style('line-dash-offset', 0);
    } else {
      this.restart();
    }
  },

  setSpeed(val) {
    _speed = Math.max(0.2, Math.min(5, parseFloat(val) || 1));
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
  if (timestamp - lastTime > 33) { // ~30 fps cap
    lastTime = timestamp;
    _offset = (_offset + _speed) % 9999;
    _cy.edges().style('line-dash-offset', -_offset);
  }
  _rafId = requestAnimationFrame(tick);
}
