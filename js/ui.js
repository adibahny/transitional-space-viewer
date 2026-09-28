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

const envOpacitySlider = document.getElementById('opacity-env');
const segOpacitySlider = document.getElementById('opacity-seg');
const blendControlSlider = document.getElementById('blend-slider');
const overlayOnlyControls = [
  document.getElementById('blend-controls'),
  document.getElementById('opacity-env-row'),
  document.getElementById('opacity-seg-row'),
].filter(Boolean);

function setActiveModeButton(mode) {
  modeOverlayBtn?.classList.toggle('active', mode === 'overlay');
  modeSplitBtn?.classList.toggle('active', mode === 'sidebyside');
}

function updateOpacityControlsForMode(mode) {
  const overlayMode = mode === 'overlay';

  // Opacity controls only belong to Overlay mode. Hide and disable them
  // in Side-by-side so both viewports are shown at their true 100% opacity.
  overlayOnlyControls.forEach((el) => {
    el.classList.toggle('overlay-only-hidden', !overlayMode);
  });

  [envOpacitySlider, segOpacitySlider, blendControlSlider].forEach((slider) => {
    if (slider) slider.disabled = !overlayMode;
  });

  // JSON/point segmentation, if present, follows the same rule as the GS
  // segmentation layer. Restore the saved slider value on return to Overlay.
  if (overlayMode) {
    const segOpacity = Number(segOpacitySlider?.value ?? 100) / 100;
    setSegPointsOpacity(segOpacity);
  } else {
    setSegPointsOpacity(1);
  }
}

modeOverlayBtn?.addEventListener('click', () => {
  setViewMode('overlay');
  setActiveModeButton('overlay');
  updateOpacityControlsForMode('overlay');
});

modeSplitBtn?.addEventListener('click', () => {
  setViewMode('sidebyside');
  setActiveModeButton('sidebyside');
  updateOpacityControlsForMode('sidebyside');
});

// Keep the UI consistent with the default mode on first load.
updateOpacityControlsForMode('overlay');

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
