/**
 * segmentation.js — Semantic Segmentation Layer
 *
 * Supports two segmentation data formats:
 *
 * FORMAT A — JSON point list (recommended):
 * {
 *   "classes": [
 *     { "id": 0, "label": "ground",    "color": "#4e9a4e" },
 *     { "id": 1, "label": "building",  "color": "#4e6fa8" },
 *     { "id": 2, "label": "vegetation","color": "#2d7a2d" },
 *     { "id": 3, "label": "road",      "color": "#808080" },
 *     { "id": 4, "label": "vehicle",   "color": "#c04040" },
 *     { "id": 5, "label": "sky",       "color": "#6bbcde" }
 *   ],
 *   "points": [
 *     { "x": 0.0, "y": 0.0, "z": 0.0, "class_id": 0 },
 *     ...
 *   ]
 * }
 *
 * FORMAT B — GeoJSON FeatureCollection (for geo-referenced data):
 * {
 *   "type": "FeatureCollection",
 *   "features": [
 *     {
 *       "type": "Feature",
 *       "geometry": { "type": "Point", "coordinates": [lon, lat, alt] },
 *       "properties": { "class_id": 1, "label": "building" }
 *     }
 *   ]
 * }
 *
 * If your segmentation is a colored .ply file, use the GS loader in viewer.js
 * and call loadSegSplat() instead.
 */

import * as THREE from 'three';
import { scene, camera } from './viewer.js';

// ─── State ────────────────────────────────────────────────────────────────────
let segPoints = null;          // THREE.Points for the seg layer
let segData   = null;          // parsed JSON data
let classMap  = new Map();     // id → { label, color, visible }
let hiddenClasses = new Set(); // class ids that are toggled off

// Raycaster for hover
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.15;
const mouse = new THREE.Vector2(-9999, -9999);

// Default class palette (used if JSON doesn't specify colors)
const DEFAULT_PALETTE = [
  '#4e9a6e', '#4e6fa8', '#2d7a2d', '#808080',
  '#c04040', '#6bbcde', '#c0884e', '#8e44ad',
  '#e67e22', '#16a085', '#2980b9', '#e74c3c',
];

// ─── Load from JSON / GeoJSON file or URL ────────────────────────────────────
export async function loadSegmentationJSON(source) {
  let json;

  if (typeof source === 'string') {
    // URL
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } else {
    // File object
    json = await readFileAsJSON(source);
  }

  if (json.type === 'FeatureCollection') {
    parseGeoJSON(json);
  } else if (json.points) {
    parsePointJSON(json);
  } else {
    throw new Error('Unknown JSON format. Expected { points: [...] } or GeoJSON FeatureCollection.');
  }

  buildThreePoints();
  buildLegend();
  setupHover();
}

// ─── Parse formats ────────────────────────────────────────────────────────────
function parsePointJSON(json) {
  segData = json;
  classMap.clear();

  // Build class map
  const classes = json.classes || [];
  classes.forEach((c, i) => {
    classMap.set(c.id, {
      label: c.label,
      color: c.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
      count: 0,
      visible: true,
    });
  });

  // Assign any unlabelled class ids encountered in points
  json.points.forEach(p => {
    if (!classMap.has(p.class_id)) {
      const i = classMap.size;
      classMap.set(p.class_id, {
        label: `class_${p.class_id}`,
        color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        count: 0,
        visible: true,
      });
    }
    classMap.get(p.class_id).count++;
  });
}

function parseGeoJSON(json) {
  // TU Delft geo origin (default)
  const ORIGIN_LAT = 52.0024;
  const ORIGIN_LON = 4.3690;
  const ORIGIN_ALT = 5.0;
  const MPD_LAT = 111320;
  const MPD_LON = MPD_LAT * Math.cos(ORIGIN_LAT * Math.PI / 180);

  classMap.clear();
  const syntheticPoints = [];

  json.features.forEach(f => {
    if (!f.geometry || f.geometry.type !== 'Point') return;
    const [lon, lat, alt = ORIGIN_ALT] = f.geometry.coordinates;
    const props = f.properties || {};
    const class_id = props.class_id ?? 0;
    const label    = props.label    ?? `class_${class_id}`;

    if (!classMap.has(class_id)) {
      const i = classMap.size;
      classMap.set(class_id, {
        label,
        color: props.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        count: 0,
        visible: true,
      });
    }
    classMap.get(class_id).count++;

    syntheticPoints.push({
      x: (lon - ORIGIN_LON) * MPD_LON,
      y: alt - ORIGIN_ALT,
      z: -(lat - ORIGIN_LAT) * MPD_LAT,  // Three.js Z is -North
      class_id,
    });
  });

  segData = { points: syntheticPoints };
}

// ─── Build Three.js Points geometry ──────────────────────────────────────────
function buildThreePoints() {
  if (segPoints) {
    scene.remove(segPoints);
    segPoints.geometry.dispose();
    segPoints.material.dispose();
    segPoints = null;
  }

  const pts = segData.points;
  const n = pts.length;

  const positions = new Float32Array(n * 3);
  const colors    = new Float32Array(n * 3);
  const classIds  = new Int32Array(n);

  const tmpColor = new THREE.Color();

  pts.forEach((p, i) => {
    positions[i * 3]     = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;

    const cls = classMap.get(p.class_id);
    tmpColor.set(cls?.color || '#ffffff');
    colors[i * 3]     = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;

    classIds[i] = p.class_id;
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  // Store class ids as a custom attribute for hover lookup
  geo.setAttribute('classId',  new THREE.Int32BufferAttribute(classIds, 1));

  const mat = new THREE.PointsMaterial({
    size: 0.08,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });

  segPoints = new THREE.Points(geo, mat);
  segPoints.name = 'segmentation-layer';
  scene.add(segPoints);
}

// ─── Legend UI ────────────────────────────────────────────────────────────────
function buildLegend() {
  const list = document.getElementById('legend-list');
  list.innerHTML = '';

  classMap.forEach((cls, id) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.classId = id;

    item.innerHTML = `
      <div class="legend-swatch" style="background:${cls.color}"></div>
      <span class="legend-label">${cls.label}</span>
      <span class="legend-count">${cls.count.toLocaleString()}</span>
    `;

    item.addEventListener('click', () => toggleClass(id, item));
    list.appendChild(item);
  });
}

function toggleClass(id, itemEl) {
  const cls = classMap.get(id);
  if (!cls) return;

  if (hiddenClasses.has(id)) {
    hiddenClasses.delete(id);
    cls.visible = true;
    itemEl.classList.remove('muted');
  } else {
    hiddenClasses.add(id);
    cls.visible = false;
    itemEl.classList.add('muted');
  }

  rebuildColors();
}

function rebuildColors() {
  if (!segPoints) return;
  const colors = segPoints.geometry.attributes.color;
  const classIds = segPoints.geometry.attributes.classId;
  const tmpColor = new THREE.Color();

  for (let i = 0; i < classIds.count; i++) {
    const id  = classIds.getX(i);
    const cls = classMap.get(id);
    if (!cls) continue;

    if (hiddenClasses.has(id)) {
      colors.setXYZ(i, 0, 0, 0);
    } else {
      tmpColor.set(cls.color);
      colors.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
    }
  }
  colors.needsUpdate = true;
}

// ─── Hover / Raycasting ───────────────────────────────────────────────────────
let hoverSetup = false;

function setupHover() {
  if (hoverSetup) return;
  hoverSetup = true;

  const container = document.getElementById('viewer-container');
  const tooltip   = document.getElementById('hover-tooltip');
  const canvas    = document.getElementById('three-canvas');

  container.addEventListener('mousemove', (e) => {
    if (!segPoints || document.pointerLockElement === canvas) {
      tooltip.classList.add('hidden');
      return;
    }

    const rect = container.getBoundingClientRect();
    mouse.x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
    mouse.y = -((e.clientY - rect.top)   / rect.height)  * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(segPoints, false);

    if (hits.length > 0) {
      const hit = hits[0];
      const idx  = hit.index;
      const classId = segPoints.geometry.attributes.classId.getX(idx);
      const cls  = classMap.get(classId);

      if (cls && !hiddenClasses.has(classId)) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
        tooltip.classList.remove('hidden');

        document.getElementById('tooltip-dot').style.background = cls.color;
        document.getElementById('tooltip-class').textContent = cls.label;
        document.getElementById('tooltip-meta').textContent =
          `id:${classId}  ·  pt:${idx.toLocaleString()}`;
        return;
      }
    }

    tooltip.classList.add('hidden');
  });
}

// ─── Visibility / opacity (called from ui.js) ─────────────────────────────────
export function setSegPointsVisible(v) {
  if (segPoints) segPoints.visible = v;
}

export function setSegPointsOpacity(v) {
  if (segPoints?.material) {
    segPoints.material.opacity = v;
    segPoints.material.transparent = v < 1;
  }
}

// ─── File → JSON helper ───────────────────────────────────────────────────────
function readFileAsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(JSON.parse(e.target.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ─── Export for ui.js ─────────────────────────────────────────────────────────
export { classMap, hiddenClasses };
