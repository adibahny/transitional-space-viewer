/**
 * ui.js — Panel controls, file loading, opacity sliders, toggles
 * Wires HTML UI to viewer.js and segmentation.js
 */

import {
  setEnvVisible,
  setSegVisible,
  setEnvOpacity,
  setSegOpacity,
  setViewMode,
  setBlend,
  setLevelCorrection,
  resetLevelCorrection,
} from './viewer.js';

import {
  setSegPointsVisible,
  setSegPointsOpacity,
} from './segmentation.js';

// ─── Layer toggles ────────────────────────────────────────────────────────────
document.getElementById('toggle-env').addEventListener('change', (e) => {
  setEnvVisible(e.target.checked);
});

document.getElementById('toggle-seg').addEventListener('change', (e) => {
  // Toggle both GS splat seg AND JSON point seg (whichever is loaded)
  setSegVisible(e.target.checked);
  setSegPointsVisible(e.target.checked);
});

// ─── Opacity sliders ─────────────────────────────────────────────────────────
document.getElementById('opacity-env').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  document.getElementById('opval-env').textContent = e.target.value + '%';
  setEnvOpacity(v);
});

document.getElementById('opacity-seg').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  document.getElementById('opval-seg').textContent = e.target.value + '%';
  setSegOpacity(v);
  setSegPointsOpacity(v);
});

// ─── Linked blend slider (Overlay mode): plain <-> colored cross-fade ────────
const blendSlider = document.getElementById('blend-slider');
if (blendSlider) {
  blendSlider.addEventListener('input', (e) => {
    const t = Number(e.target.value) / 100; // 0 = plain, 1 = colored
    const { env, seg } = setBlend(t);
    setSegPointsOpacity(seg);

    const envPct = Math.round(env * 100);
    const segPct = Math.round(seg * 100);

    const envSlider = document.getElementById('opacity-env');
    const segSlider = document.getElementById('opacity-seg');
    if (envSlider) envSlider.value = envPct;
    if (segSlider) segSlider.value = segPct;
    document.getElementById('opval-env').textContent = envPct + '%';
    document.getElementById('opval-seg').textContent = segPct + '%';
  });
}

// ─── View mode toggle: Overlay vs Side-by-side ───────────────────────────────
const modeOverlayBtn = document.getElementById('mode-overlay');
const modeSplitBtn = document.getElementById('mode-split-btn');

function setActiveModeButton(mode) {
  modeOverlayBtn?.classList.toggle('active', mode === 'overlay');
  modeSplitBtn?.classList.toggle('active', mode === 'sidebyside');
}

modeOverlayBtn?.addEventListener('click', () => {
  setViewMode('overlay');
  setActiveModeButton('overlay');
});

modeSplitBtn?.addEventListener('click', () => {
  setViewMode('sidebyside');
  setActiveModeButton('sidebyside');
});

// ─── Level / align sliders — rotates env+seg together so the room lines ─────
// ─── up with the world axes instead of sitting on a diagonal.           ─────
['x', 'y', 'z'].forEach((axis) => {
  const slider = document.getElementById(`level-${axis}`);
  const valueEl = document.getElementById(`level-${axis}-val`);
  if (!slider) return;

  slider.addEventListener('input', (e) => {
    const deg = Number(e.target.value);
    if (valueEl) valueEl.textContent = deg.toFixed(1) + '°';
    setLevelCorrection(axis, deg);
  });
});

document.getElementById('level-reset')?.addEventListener('click', () => {
  resetLevelCorrection();
  ['x', 'y', 'z'].forEach((axis) => {
    const slider = document.getElementById(`level-${axis}`);
    const valueEl = document.getElementById(`level-${axis}-val`);
    if (slider) slider.value = 0;
    if (valueEl) valueEl.textContent = '0.0°';
  });
});
