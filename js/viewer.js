/**
 * viewer.js — Two synced Gaussian Splat viewers (env + seg)
 *
 * TWO THINGS LEARNED ABOUT @mkkellogg/gaussian-splats-3d THE HARD WAY,
 * both about why a smooth Plain ↔ Colored fade needed a different approach
 * each time:
 *   1. Per-scene "opacity" (when env+seg are merged into one splatMesh) is
 *      only a hard on/off gate in the vertex shader — above ~0.01 renders
 *      fully opaque, below is discarded. Never a real blend.
 *   2. Splitting back into two separate viewers and using the ordinary
 *      three.js `material.opacity` doesn't work either — this library's 3D
 *      splat fragment shader computes its own local `opacity` purely from
 *      the Gaussian falloff and the splat's own vertex color alpha, and
 *      never multiplies in `material.opacity` at all. Setting it is a
 *      silent no-op, which is why the layer just kept showing at full
 *      strength no matter where the slider was.
 *
 * What DOES work: plain CSS `opacity` on each viewer's own DOM element.
 * The browser composites that regardless of what either shader does
 * internally, so it reliably fades the whole rendered layer. See
 * applyEnvVisualState / applySegVisualState below.
 *
 * To keep everything else that was fixed along the way (shared camera so
 * env + seg never drift apart, no camera reset when switching segmentation
 * presets, rotating in place around the model's own center), the env
 * viewer's camera is the single source of truth and gets copied onto the
 * seg viewer's camera every frame — so seg always mirrors env exactly,
 * without needing its own controls at all.
 *
 * Features:
 *   - 1 environment layer + 1 active segmentation layer at a time
 *   - switch between 5 segmentation presets
 *   - Overlay mode: true smooth cross-fade (env + seg stacked, same camera)
 *   - Side-by-side mode: two viewports, same camera, so rotating/zooming
 *     one moves the other identically — dragging/scrolling on EITHER half
 *     works, since the seg half forwards its input onto env's canvas
 *   - Camera is created once and never reset when switching segmentation
 *     presets or nudging the level-correction sliders
 *   - no Cesium
 */

import * as THREE from 'three';

export let scene = null;   // kept live for segmentation.js's hover/raycasting
export let camera = null;  // kept live for segmentation.js's hover/raycasting
export let renderer = null;
export let clock = null;

export let gsViewer = null;    // = envViewer, kept for backwards compatibility
export let gsSegViewer = null; // = segViewer, kept for backwards compatibility

export const GEO_ORIGIN = { lat: 52.0024, lon: 4.3690, alt: 5.0 };

let GS = null;

// ====== CHANGE THESE PATHS TO YOUR REAL FILES ======
// The "polos" / plain environment splat — click-to-load, no upload needed.
const ENV_PRESET_PATH = 'data/splats/all.splat';

const SEGMENTATION_PRESETS = {
    area1: 'data/segmentation/pretsgreen.splat',
    area2: 'data/segmentation/pretsyellow.splat',
    area3: 'data/segmentation/tsred.splat',
    area4: 'data/segmentation/postsgren.splat',
    allarea: 'data/segmentation/allcolour.splat',
};
// ===================================================

// ─── View mode: "overlay" | "sidebyside" ──────────────────────────────
let viewMode = 'overlay';

let envViewer = null;
let segViewer = null;
let renderLoopStarted = false;

// ─── Opacity / visibility state — persists across scene rebuilds ─────
let envOpacityState = 1.0;
let segOpacityState = 0.7;
let envVisibleState = true;
let segVisibleState = true;

// ─── Level / align correction (degrees), applied to BOTH env + seg so ─
// ─── they stay lined up with each other while you level the whole    ─
// ─── thing against the world axes. Persists across scene rebuilds.   ─
//
// BASE_LEVEL_DEG is the leveling this particular scan needs baked in as
// the startup default (found by dragging the X slider to 30° and liking
// it) — the sliders themselves stay showing 0° at that point and only
// express an ADDITIONAL offset on top of this baseline, so "Reset"
// returns you to the already-leveled default instead of an unleveled 0.
const BASE_LEVEL_DEG = { x: 30, y: 0, z: 0 };
let levelCorrectionDeg = { x: 0, y: 0, z: 0 };

// The point (in the environment's own local/raw coordinates) that the
// level sliders rotate around, and that the orbit camera centers on.
// Without this, rotating spins the model around wherever the file's own
// origin happens to be, which is usually nowhere near its visual center.
let pivotLocal = null;

async function loadGSLib() {
    if (GS) return true;

    const cdns = [
        'https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.5/build/gaussian-splats-3d.module.js',
        'https://unpkg.com/@mkkellogg/gaussian-splats-3d@0.4.5/build/gaussian-splats-3d.module.js',
        'https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.4/build/gaussian-splats-3d.module.js',
    ];

    for (const url of cdns) {
        try {
            console.log('[GS] Trying:', url);
            GS = await import(url);
            console.log('[GS] Loaded. Exports:', Object.keys(GS));
            return true;
        } catch (e) {
            console.warn('[GS] Failed:', e.message);
        }
    }

    setStatus('GS library failed — check internet connection', 'error');
    return false;
}

export async function initViewer() {
    const cesium = document.getElementById('cesium-container');
    if (cesium) cesium.style.display = 'none';

    const threeCanvas = document.getElementById('three-canvas');
    if (threeCanvas) threeCanvas.style.display = 'none';

    setStatus('Loading GS library…', 'loading');
    const ok = await loadGSLib();

    if (ok) {
        setStatus('Ready', 'ready');
    }

    updateCoordsDummy();

    // Auto-load both layers on startup. The plain environment loads first
    // so it establishes the shared pivot/camera context; then the complete
    // segmentation layer (All Area) is loaded on top automatically.
    if (ok) {
        await loadEnvPreset();
        await loadSegPreset('allarea');
    } else {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.add('hidden');
    }
}

function clearRoot(id) {
    const root = document.getElementById(id);
    if (root) root.innerHTML = '';
}

// The env viewer is the single source of truth for the camera — this is
// the one whose canvas actually has mouse controls attached.
async function ensureEnvViewer() {
    if (envViewer) return envViewer;

    const ViewerClass = GS.Viewer ?? GS.default?.Viewer;
    if (!ViewerClass) {
        throw new Error('Viewer not found in GS lib. Exports: ' + Object.keys(GS).join(', '));
    }

    const root = document.getElementById('gs-root-env');
    if (!root) throw new Error('Missing #gs-root-env element in HTML.');

    clearRoot('gs-root-env');

    envViewer = new ViewerClass({
        rootElement: root,
        useBuiltInControls: true,
        initialCameraPosition: [13.387, -1.297, -38.206],
        initialCameraLookAt: [4.055, -1.763, -37.824],
        cameraUp: [0, -1, -0.6],
        ignoreDevicePixelRatio: false,
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,
        // true = position/rotation can be changed live (needed for the
        // level/align sliders below to update in real time).
        dynamicScene: true,
        // We drive rendering ourselves so we can copy this camera onto
        // the segmentation viewer every frame.
        selfDrivenMode: false,
    });

    gsViewer = envViewer; // backwards-compat alias

    window._envViewer = envViewer;

    startRenderLoop();

    return envViewer;
}

// The seg viewer never uses its own controls — its camera is overwritten
// every frame from the env viewer's, so it always mirrors it exactly,
// whether that's stacked as an overlay or sitting in its own viewport.
async function ensureSegViewer() {
    if (segViewer) return segViewer;

    const ViewerClass = GS.Viewer ?? GS.default?.Viewer;
    if (!ViewerClass) {
        throw new Error('Viewer not found in GS lib. Exports: ' + Object.keys(GS).join(', '));
    }

    const root = document.getElementById('gs-root-seg');
    if (!root) throw new Error('Missing #gs-root-seg element in HTML.');

    clearRoot('gs-root-seg');

    segViewer = new ViewerClass({
        rootElement: root,
        useBuiltInControls: false,
        initialCameraPosition: [13.387, -1.297, -38.206],
        initialCameraLookAt: [4.055, -1.763, -37.824],
        cameraUp: [0, -1, -0.6],
        ignoreDevicePixelRatio: false,
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,
        dynamicScene: true,
        selfDrivenMode: false,
    });

    gsSegViewer = segViewer; // backwards-compat alias

    window._segViewer = segViewer;

    return segViewer;
}

function startRenderLoop() {
    if (renderLoopStarted) return;
    renderLoopStarted = true;

    function frame() {
        requestAnimationFrame(frame);
        if (!envViewer || !envViewer.initialized) return;

        envViewer.update();
        envViewer.render();

        // Keep the exported bindings live for segmentation.js's raycaster.
        scene = envViewer.threeScene;
        camera = envViewer.camera;

        if (segViewer && segViewer.initialized) {
            copyCameraTransform(envViewer.camera, segViewer.camera);
            segViewer.update();
            segViewer.render();
        }
    }

    requestAnimationFrame(frame);
}

// ─── Side-by-side input forwarding ─────────────────────────────────────
// env's OrbitControls only ever listens on env's own canvas
// (envViewer.renderer.domElement). That's fine in overlay mode, where
// #gs-root-seg sits pointer-events:none right on top of env so clicks
// fall straight through to it — but in side-by-side mode the two roots
// sit next to each other instead of stacked, so the seg half has nothing
// underneath it to fall through to, and dragging there did nothing.
// Fix: let #gs-root-seg actually receive events in split mode (see the
// CSS), then re-dispatch the same pointer/wheel events onto env's real
// canvas so its controls pick them up no matter which half you're on —
// since seg's camera is copied from env every frame anyway, both sides
// end up moving together either way.
function setupSideBySideInputForwarding() {
    const segRoot = document.getElementById('gs-root-seg');
    if (!segRoot) return;

    const forwardTo = () => envViewer?.renderer?.domElement || null;

    const pointerInit = (e) => ({
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: e.button,
        buttons: e.buttons,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
    });

    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((type) => {
        segRoot.addEventListener(type, (e) => {
            if (viewMode !== 'sidebyside') return;
            const target = forwardTo();
            if (!target) return;
            target.dispatchEvent(new PointerEvent(type, pointerInit(e)));
            e.preventDefault();
        });
    });

    segRoot.addEventListener('wheel', (e) => {
        if (viewMode !== 'sidebyside') return;
        const target = forwardTo();
        if (!target) return;
        target.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: e.clientX,
            clientY: e.clientY,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
        }));
        e.preventDefault();
    }, { passive: false });

    // Right-click-drag pans — suppress the browser context menu on the
    // seg half too, same as it's implicitly suppressed on the env half.
    segRoot.addEventListener('contextmenu', (e) => {
        if (viewMode !== 'sidebyside') return;
        e.preventDefault();
    });
}

function copyCameraTransform(fromCam, toCam) {
    toCam.position.copy(fromCam.position);
    toCam.quaternion.copy(fromCam.quaternion);
    toCam.zoom = fromCam.zoom;
    toCam.fov = fromCam.fov;
    toCam.near = fromCam.near;
    toCam.far = fromCam.far;
    toCam.updateProjectionMatrix();
}

// IMPORTANT: this library's 3D splat shader computes its own per-splat
// alpha (`exp(-0.5*A) * vColor.a`) and never reads THREE.Material's
// `.opacity` uniform at all — so setting `material.opacity` is a silent
// no-op for this render mode. That's why the layer just kept showing at
// full strength no matter where the slider was. The one thing that DOES
// reliably fade a whole canvas is plain CSS opacity on the DOM element
// itself, which the browser composites regardless of what the WebGL
// shader does internally — so that's what these two functions use.
function applyEnvVisualState() {
    const root = document.getElementById('gs-root-env');
    // Opacity blending is an Overlay-only feature. In Side-by-side mode
    // each viewport is shown at full opacity, while the saved overlay
    // opacity value is preserved and restored when returning to Overlay.
    const effectiveOpacity = viewMode === 'sidebyside' ? 1 : envOpacityState;
    if (root) root.style.opacity = envVisibleState ? String(effectiveOpacity) : '0';
    if (envViewer?.splatMesh) envViewer.splatMesh.visible = envVisibleState;
}

function applySegVisualState() {
    const root = document.getElementById('gs-root-seg');
    const effectiveOpacity = viewMode === 'sidebyside' ? 1 : segOpacityState;
    if (root) root.style.opacity = segVisibleState ? String(effectiveOpacity) : '0';
    if (segViewer?.splatMesh) segViewer.splatMesh.visible = segVisibleState;
}

// Estimates the geometric center of a splat scene by sampling its raw
// (untransformed) splat centers — cheap even for large scans since it
// only samples up to ~20k points rather than walking every splat.
function computeSceneCentroid(splatScene) {
    if (!splatScene?.splatBuffer) return null;
    const buffer = splatScene.splatBuffer;
    const count = buffer.getSplatCount();
    if (!count) return null;

    const tmp = new THREE.Vector3();
    const sum = new THREE.Vector3();
    const step = Math.max(1, Math.floor(count / 20000));
    let sampled = 0;
    for (let i = 0; i < count; i += step) {
        buffer.getSplatCenter(i, tmp, false);
        sum.add(tmp);
        sampled++;
    }
    return sampled ? sum.multiplyScalar(1 / sampled) : null;
}

// Rotates env + seg together, in place, around their shared pivot — so
// the room lines up with the world axes without swinging away from
// view. Because dynamicScene is on, this updates live as the sliders
// move, no reload needed.
function applyLevelCorrection() {
    if (!pivotLocal) return;

    const rx = THREE.MathUtils.degToRad(BASE_LEVEL_DEG.x + levelCorrectionDeg.x);
    const ry = THREE.MathUtils.degToRad(BASE_LEVEL_DEG.y + levelCorrectionDeg.y);
    const rz = THREE.MathUtils.degToRad(BASE_LEVEL_DEG.z + levelCorrectionDeg.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));

    // Rotating about an arbitrary pivot P (instead of the origin) means:
    // worldPos = q * (localPos - P) + P = q*localPos + (P - q*P)
    // so position = P - q*P keeps P itself fixed in world space while
    // everything else spins around it.
    const rotatedPivot = pivotLocal.clone().applyQuaternion(q);
    const posOffset = pivotLocal.clone().sub(rotatedPivot);

    const envScene = envViewer?.splatMesh?.getScene(0);
    const segScene = segViewer?.splatMesh?.getScene(0);
    if (envScene) { envScene.quaternion.copy(q); envScene.position.copy(posOffset); }
    if (segScene) { segScene.quaternion.copy(q); segScene.position.copy(posOffset); }

    // Keep the orbit target centered on the model too, so dragging to
    // orbit feels like turning around the room instead of swinging
    // around some corner of it. The pivot's world position is always
    // exactly pivotLocal itself — that's what the offset above buys us.
    if (envViewer?.controls) {
        envViewer.controls.target.copy(pivotLocal);
    }
}

export function setLevelCorrection(axis, degrees) {
    if (!(axis in levelCorrectionDeg)) return;
    levelCorrectionDeg[axis] = degrees;
    applyLevelCorrection();
}

export function getLevelCorrection() {
    return { ...levelCorrectionDeg };
}

export function resetLevelCorrection() {
    levelCorrectionDeg = { x: 0, y: 0, z: 0 };
    applyLevelCorrection();
}

export function setViewMode(mode) {
    viewMode = mode === 'sidebyside' ? 'sidebyside' : 'overlay';

    const container = document.getElementById('viewer-container');
    if (container) container.classList.toggle('mode-split', viewMode === 'sidebyside');

    // Re-apply visual state immediately so Side-by-side is always 100%
    // opacity and Overlay restores the user's previously selected values.
    applyEnvVisualState();
    applySegVisualState();
}

export function getViewMode() {
    return viewMode;
}

function showLoader(show, pct = 0) {
    const o = document.getElementById('loading-overlay');
    if (!o) return;

    if (show) {
        o.classList.remove('hidden');
        const bar = document.getElementById('loader-bar');
        const pctEl = document.getElementById('loader-pct');
        if (bar) bar.style.width = Math.min(pct, 100) + '%';
        if (pctEl) pctEl.textContent = Math.min(pct, 100) + '%';
    } else {
        o.classList.add('hidden');
    }
}

function updateCoordsDummy() {
    const latEl = document.getElementById('lat-val');
    const lonEl = document.getElementById('lon-val');
    const altEl = document.getElementById('alt-val');

    if (latEl) latEl.textContent = GEO_ORIGIN.lat.toFixed(4);
    if (lonEl) lonEl.textContent = GEO_ORIGIN.lon.toFixed(4);
    if (altEl) altEl.textContent = GEO_ORIGIN.alt.toFixed(1);
}

export function setStatus(msg, type = 'loading') {
    const pill = document.getElementById('status-pill');
    const text = document.getElementById('status-text');
    if (pill) pill.className = 'status-pill ' + type;
    if (text) text.textContent = msg;
}

function setActiveAreaButton(areaKey) {
    document.querySelectorAll('.seg-area-btn').forEach(btn => btn.classList.remove('active'));
    if (!areaKey) return;
    document.getElementById(`btn-${areaKey}`)?.classList.add('active');
}

// ─── GitHub Pages-safe splat loading ─────────────────────────────────
// GitHub Pages can serve the .splat files through CDN responses whose
// metadata does not match what this GS library expects when it fetches
// the URL directly. Fetch the complete file ourselves first, then give
// the library a browser Blob URL with an explicit SPLAT format.
async function addSplatFromSource(viewer, source) {
    const response = await fetch(source, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`Failed to fetch ${source}: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    try {
        await viewer.addSplatScene(blobUrl, {
            format: GS.SceneFormat.Splat,
            splatAlphaRemovalThreshold: 1,
            showLoadingUI: false,
            onProgress: (pct) =>
                showLoader(true, Math.round((pct || 0) * 100)),
        });
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

// ─── Environment layer ───────────────────────────────────────────────
// Environment requests are serialized so repeated reload clicks cannot
// overlap. A reload rebuilds the environment viewer rather than trying
// to remove a scene from an already-used GS viewer instance.
let envLoadBusy = false;
let pendingEnvSource = undefined; // undefined = nothing queued

export async function loadEnvSplat(source) {
    pendingEnvSource = source;
    if (envLoadBusy) return;

    envLoadBusy = true;
    try {
        while (pendingEnvSource !== undefined) {
            const src = pendingEnvSource;
            pendingEnvSource = undefined;
            await doLoadEnvSplat(src);
        }
    } finally {
        envLoadBusy = false;
    }
}

async function disposeEnvViewer() {
    if (envViewer) {
        try { envViewer.dispose(); } catch (e) { console.warn('[GS] envViewer dispose warning:', e); }
    }
    envViewer = null;
    gsViewer = null;
    window._envViewer = null;
    clearRoot('gs-root-env');
}

async function doLoadEnvSplat(source) {
    if (!(await loadGSLib())) return;

    setStatus('Loading environment…', 'loading');
    showLoader(true, 0);

    try {
        await ensureEnvViewer();

        // For an explicit environment reload, rebuild the GS viewer instead
        // of removeSplatScene(). This avoids the library's internal
        // load/unload state getting wedged, while the single render loop
        // continues to use the fresh envViewer instance automatically.
        if (envViewer.splatMesh && envViewer.splatMesh.getSceneCount() > 0) {
            await disposeEnvViewer();
            await ensureEnvViewer();
        }

        await addSplatFromSource(envViewer, source);

        // Environment is the canonical geometry — always recompute the
        // shared pivot from it so env + seg rotate about the same point.
        pivotLocal = computeSceneCentroid(envViewer.splatMesh.getScene(0)) || pivotLocal;
        applyLevelCorrection();
        applyEnvVisualState();

        const name = typeof source === 'string' ? source.split('/').pop() : source.name;
        document.getElementById('env-hint').textContent = name;

        showLoader(false);
        setStatus('Environment loaded ✓', 'ready');
        updateCoordsDummy();
    } catch (err) {
        console.error('[GS] Env error:', err);
        // Whatever failed, don't leave a half-broken viewer behind for
        // the next attempt to inherit — throw it away so a retry (or the
        // next click) starts from a clean instance instead of hanging.
        await disposeEnvViewer();
        showLoader(false);
        setStatus('Error: ' + err.message, 'error');
    }
}

// Click-to-load environment preset — no file upload required.
export async function loadEnvPreset() {
    await loadEnvSplat(ENV_PRESET_PATH);
}

// ─── Segmentation layer ──────────────────────────────────────────────
// Area changes are serialized: only one segmentation load/clear can be
// in flight. Extra clicks simply replace pendingSegAction, so after the
// current operation finishes we jump straight to the LAST requested
// preset instead of trying to load every intermediate click. Each actual
// preset load uses a fresh segViewer instance (see doLoadSegSplat).
let segLoadBusy = false;
let pendingSegAction = null; // { type: 'load', source, label } | { type: 'clear' }

async function runSegQueue() {
    if (segLoadBusy) return;
    segLoadBusy = true;
    try {
        while (pendingSegAction) {
            const action = pendingSegAction;
            pendingSegAction = null;
            if (action.type === 'clear') {
                await doClearSegSplat();
            } else {
                await doLoadSegSplat(action.source, action.label);
            }
        }
    } finally {
        segLoadBusy = false;
    }
}

export async function clearSegSplat() {
    pendingSegAction = { type: 'clear' };
    await runSegQueue();
}

async function disposeSegViewer() {
    if (segViewer) {
        try { segViewer.dispose(); } catch (e) { console.warn('[GS] segViewer dispose warning:', e); }
    }
    segViewer = null;
    gsSegViewer = null;
    window._segViewer = null;
    clearRoot('gs-root-seg');
}

async function doClearSegSplat() {
    // A segmentation layer is disposable. Rebuilding it is safer than
    // removeSplatScene(), which can leave this library in a stuck
    // load/unload state after repeated area switching.
    await disposeSegViewer();
    setActiveAreaButton(null);
    document.getElementById('seg-hint').textContent = 'No file loaded';
    setStatus('Segmentation cleared', 'ready');
}

export async function loadSegSplat(source, label = null) {
    pendingSegAction = { type: 'load', source, label };
    await runSegQueue();
}

async function doLoadSegSplat(source, label) {
    if (!(await loadGSLib())) return;

    setStatus('Loading segmentation…', 'loading');
    showLoader(true, 0);

    try {
        // Each segmentation preset gets a fresh viewer instance. This
        // deliberately avoids removeSplatScene() and the library's stuck
        // busy-state / late-cleanup race. The camera is copied from the
        // environment every frame, so rebuilding segmentation does NOT
        // reset the user's viewpoint.
        await disposeSegViewer();
        await ensureSegViewer();

        await addSplatFromSource(segViewer, source);

        // Only fall back to the segmentation's own centroid if no
        // environment has established the shared pivot yet.
        if (!pivotLocal) pivotLocal = computeSceneCentroid(segViewer.splatMesh.getScene(0));
        applyLevelCorrection();
        applySegVisualState();

        const name = label || (typeof source === 'string' ? source.split('/').pop() : source.name);
        document.getElementById('seg-hint').textContent = name;

        showLoader(false);
        setStatus('Segmentation loaded ✓', 'ready');
        updateCoordsDummy();
    } catch (err) {
        console.error('[GS] Seg error:', err);
        // Don't leave a half-broken seg viewer behind — rebuild it so
        // the next click (or a retry of this same one) starts clean
        // instead of hanging the same way again.
        await disposeSegViewer();
        showLoader(false);
        setStatus('Seg error: ' + err.message + ' — click the area again', 'error');
    }
}

export async function loadSegPreset(areaKey) {
    const src = SEGMENTATION_PRESETS[areaKey];
    if (!src) {
        setStatus(`Unknown area: ${areaKey}`, 'error');
        return;
    }

    setActiveAreaButton(areaKey);
    await loadSegSplat(src, areaKey.toUpperCase());
}

// ─── Visibility / opacity (called from ui.js) — applied as CSS opacity ─
// ─── on each viewer's own DOM element (see the comment above the two ──
// ─── applyXVisualState functions for why it has to be done this way). ─
export function setEnvVisible(v) {
    envVisibleState = !!v;
    applyEnvVisualState();
}

export function setSegVisible(v) {
    segVisibleState = !!v;
    applySegVisualState();
}

export function setEnvOpacity(v) {
    envOpacityState = v;
    applyEnvVisualState();
}

export function setSegOpacity(v) {
    segOpacityState = v;
    applySegVisualState();
}

// Linked blend: 0 = fully plain, 1 = fully colored. The plain layer fades
// out exactly as much as the colored layer fades in.
export function setBlend(t) {
    const clamped = Math.min(1, Math.max(0, t));
    setEnvOpacity(1 - clamped);
    setSegOpacity(clamped);
    return { env: 1 - clamped, seg: clamped };
}

window.setMode = function () { };
window.toggleSatellite = function () { };
window.switchMap = function () { };
window.toggleCesiumBg = function () { };
window.loadSegPreset = loadSegPreset;
window.loadEnvPreset = loadEnvPreset;
window.clearSegSplat = clearSegSplat;

setupSideBySideInputForwarding();
initViewer();