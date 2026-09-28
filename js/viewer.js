/**
 * viewer.js — Two synced Gaussian Splat viewers (env + seg)
 *
 * - GitHub Pages-safe Blob loading
 * - Auto-load environment + All Area
 * - Fresh segmentation viewer on area switching
 * - Overlay opacity / Side-by-side full opacity
 * - Mobile memory optimisations
 */

import * as THREE from 'three';

export let scene = null;
export let camera = null;
export let renderer = null;
export let clock = null;

export let gsViewer = null;
export let gsSegViewer = null;

export const GEO_ORIGIN = {
    lat: 52.0024,
    lon: 4.3690,
    alt: 5.0
};

let GS = null;


/* =========================================================
   MOBILE DETECTION
   ========================================================= */

const IS_MOBILE = (() => {

    if (
        navigator.userAgentData &&
        typeof navigator.userAgentData.mobile === 'boolean'
    ) {
        return navigator.userAgentData.mobile;
    }

    const ua = navigator.userAgent || '';

    // iPad can sometimes identify itself as Macintosh
    const isiPadDesktopUA =
        /Macintosh/i.test(ua) &&
        navigator.maxTouchPoints > 1;

    return (
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
        isiPadDesktopUA
    );

})();


// Used to prevent mobile browser crash → reload →
// automatically load segmentation → crash → reload loop.
const MOBILE_AUTO_SEG_GUARD =
    'gs-mobile-auto-seg-loading';


// Slightly remove nearly invisible splats on mobile.
const MOBILE_SPLAT_ALPHA_THRESHOLD = 5;



/* =========================================================
   FILE PATHS
   ========================================================= */

const ENV_PRESET_PATH =
    'data/splats/all.splat';


const SEGMENTATION_PRESETS = {

    area1:
        'data/segmentation/pretsgreen.splat',

    area2:
        'data/segmentation/pretsyellow.splat',

    area3:
        'data/segmentation/tsred.splat',

    area4:
        'data/segmentation/postsgren.splat',

    allarea:
        'data/segmentation/allcolour.splat',

};



/* =========================================================
   GLOBAL VIEWER STATE
   ========================================================= */

let viewMode = 'overlay';

let envViewer = null;
let segViewer = null;

let renderLoopStarted = false;



/* =========================================================
   OPACITY / VISIBILITY STATE
   ========================================================= */

let envOpacityState = 1.0;
let segOpacityState = 0.7;

let envVisibleState = true;
let segVisibleState = true;



/* =========================================================
   LEVEL / ALIGNMENT
   ========================================================= */

const BASE_LEVEL_DEG = {
    x: 30,
    y: 0,
    z: 0
};

let levelCorrectionDeg = {
    x: 0,
    y: 0,
    z: 0
};


// Shared geometric pivot between environment
// and segmentation.
let pivotLocal = null;



/* =========================================================
   LOAD GAUSSIAN SPLATS LIBRARY
   ========================================================= */

async function loadGSLib() {

    if (GS) return true;

    const cdns = [

        'https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.5/build/gaussian-splats-3d.module.js',

        'https://unpkg.com/@mkkellogg/gaussian-splats-3d@0.4.5/build/gaussian-splats-3d.module.js',

        'https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.4/build/gaussian-splats-3d.module.js',

    ];


    for (const url of cdns) {

        try {

            console.log(
                '[GS] Trying:',
                url
            );

            GS = await import(url);

            console.log(
                '[GS] Loaded. Exports:',
                Object.keys(GS)
            );

            return true;

        } catch (e) {

            console.warn(
                '[GS] Failed:',
                e.message
            );

        }

    }


    setStatus(
        'GS library failed — check internet connection',
        'error'
    );

    return false;
}



/* =========================================================
   INITIALISE VIEWER
   ========================================================= */

export async function initViewer() {

    const cesium =
        document.getElementById(
            'cesium-container'
        );

    if (cesium) {
        cesium.style.display = 'none';
    }


    const threeCanvas =
        document.getElementById(
            'three-canvas'
        );

    if (threeCanvas) {
        threeCanvas.style.display = 'none';
    }


    setStatus(
        'Loading GS library…',
        'loading'
    );


    const ok =
        await loadGSLib();


    if (ok) {

        setStatus(
            'Ready',
            'ready'
        );

    }


    updateCoordsDummy();


    /*
     * STARTUP ORDER:
     *
     * 1. Load all.splat
     * 2. Environment establishes pivot
     * 3. Load allcolour.splat
     *
     * Desktop:
     * automatically loads both.
     *
     * Mobile:
     * still tries automatic All Area,
     * but includes a crash-loop guard.
     */

    if (ok) {

        await loadEnvPreset();


        if (IS_MOBILE) {

            const recoveringFromAutoSegReload =
                sessionStorage.getItem(
                    MOBILE_AUTO_SEG_GUARD
                ) === '1';


            if (recoveringFromAutoSegReload) {

                // The previous automatic segmentation load
                // may have caused the mobile browser to be
                // killed/reloaded.
                //
                // Do not immediately repeat it.

                sessionStorage.removeItem(
                    MOBILE_AUTO_SEG_GUARD
                );


                setActiveAreaButton(null);


                const segHint =
                    document.getElementById(
                        'seg-hint'
                    );


                if (segHint) {

                    segHint.textContent =
                        'Mobile safe mode — tap All Area to load';

                }


                showLoader(false);


                setStatus(
                    'Environment loaded — mobile safe mode',
                    'ready'
                );

            } else {

                sessionStorage.setItem(
                    MOBILE_AUTO_SEG_GUARD,
                    '1'
                );


                // Give browser time to release temporary
                // environment Blob memory before allocating
                // segmentation data.
                await new Promise(
                    (resolve) =>
                        setTimeout(
                            resolve,
                            800
                        )
                );


                await loadSegPreset(
                    'allarea'
                );


                sessionStorage.removeItem(
                    MOBILE_AUTO_SEG_GUARD
                );

            }

        } else {

            await loadSegPreset(
                'allarea'
            );

        }

    } else {

        const overlay =
            document.getElementById(
                'loading-overlay'
            );


        if (overlay) {

            overlay.classList.add(
                'hidden'
            );

        }

    }

}



/* =========================================================
   DOM ROOT UTILITY
   ========================================================= */

function clearRoot(id) {

    const root =
        document.getElementById(id);

    if (root) {
        root.innerHTML = '';
    }

}



/* =========================================================
   CREATE ENVIRONMENT VIEWER
   ========================================================= */

async function ensureEnvViewer() {

    if (envViewer) {
        return envViewer;
    }


    const ViewerClass =
        GS.Viewer ??
        GS.default?.Viewer;


    if (!ViewerClass) {

        throw new Error(
            'Viewer not found in GS lib. Exports: ' +
            Object.keys(GS).join(', ')
        );

    }


    const root =
        document.getElementById(
            'gs-root-env'
        );


    if (!root) {

        throw new Error(
            'Missing #gs-root-env element in HTML.'
        );

    }


    clearRoot(
        'gs-root-env'
    );


    envViewer =
        new ViewerClass({

            rootElement: root,

            useBuiltInControls: true,

            initialCameraPosition:
                [
                    13.387,
                    -1.297,
                    -38.206
                ],

            initialCameraLookAt:
                [
                    4.055,
                    -1.763,
                    -37.824
                ],

            cameraUp:
                [
                    0,
                    -1,
                    -0.6
                ],


            /*
             * MOBILE:
             * Render at CSS resolution instead of
             * multiplying by high devicePixelRatio.
             *
             * This can dramatically reduce framebuffer
             * memory on phones.
             */
            ignoreDevicePixelRatio:
                IS_MOBILE,


            gpuAcceleratedSort:
                false,


            sharedMemoryForWorkers:
                false,


            /*
             * Release intermediate CPU-side splat data
             * on mobile whenever possible.
             */
            freeIntermediateSplatData:
                IS_MOBILE,


            /*
             * Desktop:
             * keep data optimisation.
             *
             * Mobile:
             * disable because optimisation can produce
             * a large temporary RAM spike immediately
             * after download reaches 100%.
             */
            optimizeSplatData:
                !IS_MOBILE,


            dynamicScene:
                true,


            /*
             * Rendering is controlled manually because
             * segmentation camera must follow environment
             * camera every frame.
             */
            selfDrivenMode:
                false,

        });


    gsViewer =
        envViewer;


    window._envViewer =
        envViewer;


    startRenderLoop();


    return envViewer;

}



/* =========================================================
   CREATE SEGMENTATION VIEWER
   ========================================================= */

async function ensureSegViewer() {

    if (segViewer) {
        return segViewer;
    }


    const ViewerClass =
        GS.Viewer ??
        GS.default?.Viewer;


    if (!ViewerClass) {

        throw new Error(
            'Viewer not found in GS lib. Exports: ' +
            Object.keys(GS).join(', ')
        );

    }


    const root =
        document.getElementById(
            'gs-root-seg'
        );


    if (!root) {

        throw new Error(
            'Missing #gs-root-seg element in HTML.'
        );

    }


    clearRoot(
        'gs-root-seg'
    );


    segViewer =
        new ViewerClass({

            rootElement: root,

            useBuiltInControls:
                false,

            initialCameraPosition:
                [
                    13.387,
                    -1.297,
                    -38.206
                ],

            initialCameraLookAt:
                [
                    4.055,
                    -1.763,
                    -37.824
                ],

            cameraUp:
                [
                    0,
                    -1,
                    -0.6
                ],


            ignoreDevicePixelRatio:
                IS_MOBILE,


            gpuAcceleratedSort:
                false,


            sharedMemoryForWorkers:
                false,


            freeIntermediateSplatData:
                IS_MOBILE,


            optimizeSplatData:
                !IS_MOBILE,


            dynamicScene:
                true,


            selfDrivenMode:
                false,

        });


    gsSegViewer =
        segViewer;


    window._segViewer =
        segViewer;


    return segViewer;

}



/* =========================================================
   RENDER LOOP
   ========================================================= */

function startRenderLoop() {

    if (renderLoopStarted) {
        return;
    }


    renderLoopStarted = true;


    function frame() {

        requestAnimationFrame(
            frame
        );


        if (
            !envViewer ||
            !envViewer.initialized
        ) {

            return;

        }


        envViewer.update();
        envViewer.render();


        // Keep exports live for segmentation.js
        scene =
            envViewer.threeScene;

        camera =
            envViewer.camera;


        /*
         * Segmentation uses exactly the same camera
         * transformation as the environment.
         */

        if (
            segViewer &&
            segViewer.initialized
        ) {

            copyCameraTransform(
                envViewer.camera,
                segViewer.camera
            );


            segViewer.update();
            segViewer.render();

        }

    }


    requestAnimationFrame(
        frame
    );

}



/* =========================================================
   SIDE-BY-SIDE INPUT FORWARDING
   ========================================================= */

function setupSideBySideInputForwarding() {

    const segRoot =
        document.getElementById(
            'gs-root-seg'
        );


    if (!segRoot) {
        return;
    }


    const forwardTo =
        () =>
            envViewer?.renderer?.domElement ||
            null;


    const pointerInit =
        (e) => ({

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


    [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel'

    ].forEach(
        (type) => {

            segRoot.addEventListener(
                type,
                (e) => {

                    if (
                        viewMode !==
                        'sidebyside'
                    ) {
                        return;
                    }


                    const target =
                        forwardTo();


                    if (!target) {
                        return;
                    }


                    target.dispatchEvent(

                        new PointerEvent(
                            type,
                            pointerInit(e)
                        )

                    );


                    e.preventDefault();

                }
            );

        }
    );


    segRoot.addEventListener(
        'wheel',
        (e) => {

            if (
                viewMode !==
                'sidebyside'
            ) {
                return;
            }


            const target =
                forwardTo();


            if (!target) {
                return;
            }


            target.dispatchEvent(

                new WheelEvent(
                    'wheel',
                    {

                        bubbles: true,
                        cancelable: true,

                        clientX: e.clientX,
                        clientY: e.clientY,

                        deltaX: e.deltaX,
                        deltaY: e.deltaY,
                        deltaZ: e.deltaZ,

                        deltaMode: e.deltaMode,

                    }
                )

            );


            e.preventDefault();

        },

        {
            passive: false
        }
    );


    segRoot.addEventListener(
        'contextmenu',
        (e) => {

            if (
                viewMode !==
                'sidebyside'
            ) {
                return;
            }

            e.preventDefault();

        }
    );

}



/* =========================================================
   CAMERA SYNC
   ========================================================= */

function copyCameraTransform(
    fromCam,
    toCam
) {

    toCam.position.copy(
        fromCam.position
    );

    toCam.quaternion.copy(
        fromCam.quaternion
    );

    toCam.zoom =
        fromCam.zoom;

    toCam.fov =
        fromCam.fov;

    toCam.near =
        fromCam.near;

    toCam.far =
        fromCam.far;


    toCam.updateProjectionMatrix();

}



/* =========================================================
   OPACITY
   ========================================================= */

function applyEnvVisualState() {

    const root =
        document.getElementById(
            'gs-root-env'
        );


    /*
     * Overlay:
     * use selected opacity.
     *
     * Side-by-side:
     * always display at 100%.
     */

    const effectiveOpacity =
        viewMode === 'sidebyside'
            ? 1
            : envOpacityState;


    if (root) {

        root.style.opacity =
            envVisibleState
                ? String(
                    effectiveOpacity
                )
                : '0';

    }


    if (
        envViewer?.splatMesh
    ) {

        envViewer.splatMesh.visible =
            envVisibleState;

    }

}


function applySegVisualState() {

    const root =
        document.getElementById(
            'gs-root-seg'
        );


    const effectiveOpacity =
        viewMode === 'sidebyside'
            ? 1
            : segOpacityState;


    if (root) {

        root.style.opacity =
            segVisibleState
                ? String(
                    effectiveOpacity
                )
                : '0';

    }


    if (
        segViewer?.splatMesh
    ) {

        segViewer.splatMesh.visible =
            segVisibleState;

    }

}



/* =========================================================
   COMPUTE SCENE CENTROID
   ========================================================= */

function computeSceneCentroid(
    splatScene
) {

    if (
        !splatScene?.splatBuffer
    ) {

        return null;

    }


    const buffer =
        splatScene.splatBuffer;


    const count =
        buffer.getSplatCount();


    if (!count) {
        return null;
    }


    const tmp =
        new THREE.Vector3();


    const sum =
        new THREE.Vector3();


    /*
     * Sampling instead of iterating through
     * every splat keeps this reasonably cheap.
     */

    const step =
        Math.max(
            1,
            Math.floor(
                count /
                20000
            )
        );


    let sampled = 0;


    for (
        let i = 0;
        i < count;
        i += step
    ) {

        buffer.getSplatCenter(
            i,
            tmp,
            false
        );


        sum.add(
            tmp
        );


        sampled++;

    }


    return sampled
        ? sum.multiplyScalar(
            1 / sampled
        )
        : null;

}



/* =========================================================
   LEVEL / ALIGNMENT
   ========================================================= */

function applyLevelCorrection() {

    if (!pivotLocal) {
        return;
    }


    const rx =
        THREE.MathUtils.degToRad(

            BASE_LEVEL_DEG.x +
            levelCorrectionDeg.x

        );


    const ry =
        THREE.MathUtils.degToRad(

            BASE_LEVEL_DEG.y +
            levelCorrectionDeg.y

        );


    const rz =
        THREE.MathUtils.degToRad(

            BASE_LEVEL_DEG.z +
            levelCorrectionDeg.z

        );


    const q =
        new THREE.Quaternion()
            .setFromEuler(

                new THREE.Euler(
                    rx,
                    ry,
                    rz,
                    'XYZ'
                )

            );


    const rotatedPivot =
        pivotLocal
            .clone()
            .applyQuaternion(q);


    const posOffset =
        pivotLocal
            .clone()
            .sub(
                rotatedPivot
            );


    const envScene =
        envViewer
            ?.splatMesh
            ?.getScene(0);


    const segScene =
        segViewer
            ?.splatMesh
            ?.getScene(0);


    if (envScene) {

        envScene.quaternion.copy(q);

        envScene.position.copy(
            posOffset
        );

    }


    if (segScene) {

        segScene.quaternion.copy(q);

        segScene.position.copy(
            posOffset
        );

    }


    if (
        envViewer?.controls
    ) {

        envViewer.controls.target.copy(
            pivotLocal
        );

    }

}



export function setLevelCorrection(
    axis,
    degrees
) {

    if (
        !(axis in levelCorrectionDeg)
    ) {

        return;

    }


    levelCorrectionDeg[axis] =
        degrees;


    applyLevelCorrection();

}



export function getLevelCorrection() {

    return {
        ...levelCorrectionDeg
    };

}



export function resetLevelCorrection() {

    levelCorrectionDeg = {
        x: 0,
        y: 0,
        z: 0
    };


    applyLevelCorrection();

}



/* =========================================================
   VIEW MODE
   ========================================================= */

export function setViewMode(
    mode
) {

    viewMode =
        mode === 'sidebyside'
            ? 'sidebyside'
            : 'overlay';


    const container =
        document.getElementById(
            'viewer-container'
        );


    if (container) {

        container.classList.toggle(
            'mode-split',
            viewMode ===
            'sidebyside'
        );

    }


    /*
     * Immediately update opacity:
     *
     * Side-by-side:
     * Env = 100%
     * Seg = 100%
     *
     * Overlay:
     * restore previous slider values.
     */

    applyEnvVisualState();
    applySegVisualState();

}



export function getViewMode() {

    return viewMode;

}



/* =========================================================
   LOADING OVERLAY
   ========================================================= */

function showLoader(
    show,
    pct = 0
) {

    const o =
        document.getElementById(
            'loading-overlay'
        );


    if (!o) {
        return;
    }


    if (show) {

        o.classList.remove(
            'hidden'
        );


        const bar =
            document.getElementById(
                'loader-bar'
            );


        const pctEl =
            document.getElementById(
                'loader-pct'
            );


        if (bar) {

            bar.style.width =
                Math.min(
                    pct,
                    100
                ) + '%';

        }


        if (pctEl) {

            pctEl.textContent =
                Math.min(
                    pct,
                    100
                ) + '%';

        }

    } else {

        o.classList.add(
            'hidden'
        );

    }

}



/* =========================================================
   COORDINATES
   ========================================================= */

function updateCoordsDummy() {

    const latEl =
        document.getElementById(
            'lat-val'
        );


    const lonEl =
        document.getElementById(
            'lon-val'
        );


    const altEl =
        document.getElementById(
            'alt-val'
        );


    if (latEl) {

        latEl.textContent =
            GEO_ORIGIN.lat
                .toFixed(4);

    }


    if (lonEl) {

        lonEl.textContent =
            GEO_ORIGIN.lon
                .toFixed(4);

    }


    if (altEl) {

        altEl.textContent =
            GEO_ORIGIN.alt
                .toFixed(1);

    }

}



/* =========================================================
   STATUS
   ========================================================= */

export function setStatus(
    msg,
    type = 'loading'
) {

    const pill =
        document.getElementById(
            'status-pill'
        );


    const text =
        document.getElementById(
            'status-text'
        );


    if (pill) {

        pill.className =
            'status-pill ' +
            type;

    }


    if (text) {

        text.textContent =
            msg;

    }

}



/* =========================================================
   ACTIVE SEGMENTATION BUTTON
   ========================================================= */

function setActiveAreaButton(
    areaKey
) {

    document
        .querySelectorAll(
            '.seg-area-btn'
        )
        .forEach(
            (btn) =>
                btn.classList.remove(
                    'active'
                )
        );


    if (!areaKey) {
        return;
    }


    document
        .getElementById(
            `btn-${areaKey}`
        )
        ?.classList.add(
            'active'
        );

}



/* =========================================================
   GITHUB PAGES-SAFE SPLAT LOADER
   ========================================================= */

/*
 * Direct addSplatScene(
 *     "data/....splat"
 * )
 *
 * failed on GitHub Pages even though fetch()
 * could retrieve the entire file.
 *
 * Therefore:
 *
 * URL
 * ↓
 * fetch
 * ↓
 * Blob
 * ↓
 * temporary blob: URL
 * ↓
 * GaussianSplats3D
 */

async function addSplatFromSource(
    viewer,
    source
) {

    const response =
        await fetch(
            source,
            {
                cache: 'no-store'
            }
        );


    if (!response.ok) {

        throw new Error(

            `Failed to fetch ${source}: ${response.status}`

        );

    }


    /*
     * IMPORTANT:
     *
     * These variables are mutable so we can explicitly
     * remove our references once loading has finished.
     */

    let blob =
        await response.blob();


    let blobUrl =
        URL.createObjectURL(
            blob
        );


    try {

        await viewer.addSplatScene(

            blobUrl,

            {

                /*
                 * Blob URLs do not have ".splat"
                 * extensions, therefore explicitly
                 * tell the library the format.
                 */

                format:
                    GS.SceneFormat.Splat,


                /*
                 * MOBILE:
                 *
                 * Avoid large post-download processing
                 * peak where possible.
                 */

                progressiveLoad:
                    IS_MOBILE,


                /*
                 * Desktop:
                 * retain everything.
                 *
                 * Mobile:
                 * remove only very faint splats.
                 */

                splatAlphaRemovalThreshold:
                    IS_MOBILE
                        ? MOBILE_SPLAT_ALPHA_THRESHOLD
                        : 1,


                showLoadingUI:
                    false,


                onProgress:
                    (pct) => {

                        showLoader(

                            true,

                            Math.round(
                                (pct || 0) *
                                100
                            )

                        );

                    },

            }

        );

    } finally {

        /*
         * Important for mobile memory.
         */

        URL.revokeObjectURL(
            blobUrl
        );


        blobUrl = null;
        blob = null;

    }

}



/* =========================================================
   ENVIRONMENT QUEUE
   ========================================================= */

let envLoadBusy = false;

let pendingEnvSource =
    undefined;



export async function loadEnvSplat(
    source
) {

    pendingEnvSource =
        source;


    if (envLoadBusy) {
        return;
    }


    envLoadBusy =
        true;


    try {

        while (
            pendingEnvSource !==
            undefined
        ) {

            const src =
                pendingEnvSource;


            pendingEnvSource =
                undefined;


            await doLoadEnvSplat(
                src
            );

        }

    } finally {

        envLoadBusy =
            false;

    }

}



/* =========================================================
   DISPOSE ENVIRONMENT VIEWER
   ========================================================= */

async function disposeEnvViewer() {

    if (envViewer) {

        try {

            envViewer.dispose();

        } catch (e) {

            console.warn(
                '[GS] envViewer dispose warning:',
                e
            );

        }

    }


    envViewer = null;
    gsViewer = null;

    window._envViewer =
        null;


    clearRoot(
        'gs-root-env'
    );

}



/* =========================================================
   LOAD ENVIRONMENT
   ========================================================= */

async function doLoadEnvSplat(
    source
) {

    if (
        !(await loadGSLib())
    ) {

        return;

    }


    setStatus(
        'Loading environment…',
        'loading'
    );


    showLoader(
        true,
        0
    );


    try {

        await ensureEnvViewer();


        /*
         * For Reload Environment:
         * recreate viewer rather than calling
         * removeSplatScene().
         */

        if (

            envViewer.splatMesh &&

            envViewer.splatMesh
                .getSceneCount() > 0

        ) {

            await disposeEnvViewer();

            await ensureEnvViewer();

        }


        await addSplatFromSource(

            envViewer,

            source

        );


        /*
         * Environment establishes the canonical pivot.
         */

        pivotLocal =

            computeSceneCentroid(

                envViewer
                    .splatMesh
                    .getScene(0)

            ) ||

            pivotLocal;


        applyLevelCorrection();

        applyEnvVisualState();


        const name =

            typeof source === 'string'

                ? source
                    .split('/')
                    .pop()

                : source.name;


        const envHint =
            document.getElementById(
                'env-hint'
            );


        if (envHint) {

            envHint.textContent =
                name;

        }


        showLoader(false);


        setStatus(
            'Environment loaded ✓',
            'ready'
        );


        updateCoordsDummy();

    } catch (err) {

        console.error(
            '[GS] Env error:',
            err
        );


        await disposeEnvViewer();


        showLoader(false);


        setStatus(
            'Error: ' +
            err.message,
            'error'
        );

    }

}



/* =========================================================
   ENVIRONMENT PRESET
   ========================================================= */

export async function loadEnvPreset() {

    await loadEnvSplat(
        ENV_PRESET_PATH
    );

}



/* =========================================================
   SEGMENTATION QUEUE
   ========================================================= */

let segLoadBusy = false;

let pendingSegAction = null;



async function runSegQueue() {

    if (segLoadBusy) {
        return;
    }


    segLoadBusy =
        true;


    try {

        while (
            pendingSegAction
        ) {

            const action =
                pendingSegAction;


            pendingSegAction =
                null;


            if (
                action.type ===
                'clear'
            ) {

                await doClearSegSplat();

            } else {

                await doLoadSegSplat(

                    action.source,

                    action.label

                );

            }

        }

    } finally {

        segLoadBusy =
            false;

    }

}



/* =========================================================
   CLEAR SEGMENTATION
   ========================================================= */

export async function clearSegSplat() {

    pendingSegAction = {
        type: 'clear'
    };


    await runSegQueue();

}



/* =========================================================
   DISPOSE SEGMENTATION VIEWER
   ========================================================= */

async function disposeSegViewer() {

    if (segViewer) {

        try {

            segViewer.dispose();

        } catch (e) {

            console.warn(
                '[GS] segViewer dispose warning:',
                e
            );

        }

    }


    segViewer = null;

    gsSegViewer = null;


    window._segViewer =
        null;


    clearRoot(
        'gs-root-seg'
    );

}



/* =========================================================
   CLEAR SEGMENTATION INTERNAL
   ========================================================= */

async function doClearSegSplat() {

    /*
     * Instead of removeSplatScene(),
     * fully dispose the segmentation viewer.
     *
     * This proved much more stable with repeated
     * area switching.
     */

    await disposeSegViewer();


    setActiveAreaButton(
        null
    );


    const hint =
        document.getElementById(
            'seg-hint'
        );


    if (hint) {

        hint.textContent =
            'No file loaded';

    }


    setStatus(
        'Segmentation cleared',
        'ready'
    );

}



/* =========================================================
   REQUEST SEGMENTATION
   ========================================================= */

export async function loadSegSplat(
    source,
    label = null
) {

    pendingSegAction = {

        type: 'load',
        source,
        label

    };


    await runSegQueue();

}



/* =========================================================
   LOAD SEGMENTATION
   ========================================================= */

async function doLoadSegSplat(
    source,
    label
) {

    if (
        !(await loadGSLib())
    ) {

        return;

    }


    setStatus(
        'Loading segmentation…',
        'loading'
    );


    showLoader(
        true,
        0
    );


    try {

        /*
         * IMPORTANT:
         *
         * Always use a fresh segmentation viewer.
         *
         * This means:
         *
         * All Area
         * → Area 1
         *
         * old segmentation is destroyed first,
         * then new segmentation is loaded.
         *
         * Environment is untouched.
         */

        await disposeSegViewer();


        await ensureSegViewer();


        await addSplatFromSource(

            segViewer,

            source

        );


        /*
         * Normally environment already supplied
         * the pivot.
         */

        if (!pivotLocal) {

            pivotLocal =

                computeSceneCentroid(

                    segViewer
                        .splatMesh
                        .getScene(0)

                );

        }


        applyLevelCorrection();

        applySegVisualState();


        const name =

            label ||

            (
                typeof source ===
                    'string'

                    ? source
                        .split('/')
                        .pop()

                    : source.name
            );


        const segHint =
            document.getElementById(
                'seg-hint'
            );


        if (segHint) {

            segHint.textContent =
                name;

        }


        showLoader(false);


        setStatus(
            'Segmentation loaded ✓',
            'ready'
        );


        updateCoordsDummy();

    } catch (err) {

        console.error(
            '[GS] Seg error:',
            err
        );


        /*
         * Never leave a half-created
         * segmentation viewer alive.
         */

        await disposeSegViewer();


        showLoader(false);


        setStatus(

            'Seg error: ' +
            err.message +
            ' — click the area again',

            'error'

        );

    }

}



/* =========================================================
   SEGMENTATION PRESET
   ========================================================= */

export async function loadSegPreset(
    areaKey
) {

    const src =
        SEGMENTATION_PRESETS[
        areaKey
        ];


    if (!src) {

        setStatus(
            `Unknown area: ${areaKey}`,
            'error'
        );

        return;

    }


    /*
     * Highlight currently selected button.
     */

    setActiveAreaButton(
        areaKey
    );


    await loadSegSplat(

        src,

        areaKey.toUpperCase()

    );

}



/* =========================================================
   VISIBILITY
   ========================================================= */

export function setEnvVisible(
    v
) {

    envVisibleState =
        !!v;


    applyEnvVisualState();

}



export function setSegVisible(
    v
) {

    segVisibleState =
        !!v;


    applySegVisualState();

}



/* =========================================================
   OPACITY
   ========================================================= */

export function setEnvOpacity(
    v
) {

    envOpacityState =
        v;


    applyEnvVisualState();

}



export function setSegOpacity(
    v
) {

    segOpacityState =
        v;


    applySegVisualState();

}



/* =========================================================
   LINKED BLEND
   ========================================================= */

export function setBlend(
    t
) {

    const clamped =
        Math.min(
            1,
            Math.max(
                0,
                t
            )
        );


    setEnvOpacity(
        1 - clamped
    );


    setSegOpacity(
        clamped
    );


    return {

        env:
            1 - clamped,

        seg:
            clamped

    };

}



/* =========================================================
   LEGACY / HTML GLOBAL FUNCTIONS
   ========================================================= */

window.setMode =
    function () { };


window.toggleSatellite =
    function () { };


window.switchMap =
    function () { };


window.toggleCesiumBg =
    function () { };


window.loadSegPreset =
    loadSegPreset;


window.loadEnvPreset =
    loadEnvPreset;


window.clearSegSplat =
    clearSegSplat;



/* =========================================================
   START
   ========================================================= */

setupSideBySideInputForwarding();

initViewer();