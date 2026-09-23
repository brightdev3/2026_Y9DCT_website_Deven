// server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Jimp, loadFont, ResizeStrategy } = require('jimp');

/* ================================================================== *
 *  Config
 * ================================================================== */

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const FONT_DIR = path.join(__dirname, 'fonts');

// Render scale. 1 = one image pixel per CSS pixel.
// < 1 = low resolution (hard edges, no blur) -> chunky / retro.
const DEFAULT_SCALE = 0.5;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

/* ================================================================== *
 *  1. FONTS
 * ================================================================== */

let fontExports = {};
try {
    fontExports = require('jimp/fonts') || {};
} catch (err) {
    console.warn('[fonts] could not load "jimp/fonts":', err.message);
}

// Discover every SANS_<size>_<weight> export instead of hard-coding a few.
// (More native sizes -> smaller corrections -> sharper text.)
const sansSizes = new Map();
for (const [key, src] of Object.entries(fontExports)) {
    const m = /^SANS_(\d+)_(BLACK|WHITE)$/.exec(key);
    if (!m || !src) continue;
    const size = Number(m[1]);
    if (!sansSizes.has(size)) sansSizes.set(size, {});
    sansSizes.get(size)[m[2]] = src;
}
// Fallback if discovery ever finds nothing (older jimp layout).
if (!sansSizes.size) {
    for (const size of [8, 16, 32, 64, 128]) {
        const entry = {};
        for (const weight of ['BLACK', 'WHITE']) {
            const src = fontExports[`SANS_${size}_${weight}`];
            if (src) entry[weight] = src;
        }
        if (Object.keys(entry).length) sansSizes.set(size, entry);
    }
}
const AVAILABLE_SIZES = [...sansSizes.keys()].sort((a, b) => a - b);

const customFonts = new Map();
try {
    for (const file of fs.readdirSync(FONT_DIR)) {
        if (/\.(fnt|json)$/i.test(file)) {
            customFonts.set(
                path.basename(file, path.extname(file)).toLowerCase(),
                path.join(FONT_DIR, file)
            );
        }
    }
} catch { /* ./fonts doesn't exist - fine */ }

const fontCache = new Map();

async function resolveFont(family, requestedSize) {
    const fam = String(family || 'sans').toLowerCase();

    if (customFonts.has(fam)) {
        const key = `custom:${fam}`;
        if (!fontCache.has(key)) fontCache.set(key, await loadFont(customFonts.get(fam)));
        return { font: fontCache.get(key), size: null };
    }

    if (!AVAILABLE_SIZES.length) throw new Error('No built-in Jimp fonts available');

    const wanted = Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : 16;
    const snapped = AVAILABLE_SIZES.reduce(
        (best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best),
        AVAILABLE_SIZES[0]
    );

    const entry = sansSizes.get(snapped);
    const key = `builtin:${snapped}`;
    if (!fontCache.has(key)) fontCache.set(key, await loadFont(entry.WHITE || entry.BLACK));
    return { font: fontCache.get(key), size: snapped };
}

// Closest native bitmap size to a wanted device-pixel size.
function nearestNativeSize(wanted) {
    let best = AVAILABLE_SIZES[0];
    let bestD = Math.abs(best - wanted);
    for (const s of AVAILABLE_SIZES) {
        const d = Math.abs(s - wanted);
        if (d < bestD - 1e-9) { bestD = d; best = s; }
    }
    return best;
}

/* ---- text metrics ------------------------------------------------- */

let jimpMeasureText = null;
try {
    const jimp = require('jimp');
    if (typeof jimp.measureText === 'function') jimpMeasureText = jimp.measureText;
} catch { /* ignore */ }

function getCharMap(font) {
    if (font.__charMap) return font.__charMap;
    const map = new Map();
    const chars = font && font.chars;

    if (Array.isArray(chars)) {
        for (const c of chars) {
            if (!c) continue;
            if (c.char != null) map.set(String(c.char), c);
            else if (c.letter != null) map.set(String(c.letter), c);
            else if (typeof c.id === 'number') map.set(String.fromCodePoint(c.id), c);
        }
    } else if (chars && typeof chars === 'object') {
        for (const [k, v] of Object.entries(chars)) map.set(k, v);
    }

    try { font.__charMap = map; } catch { /* frozen */ }
    return map;
}

function measureLine(font, text, fallbackSize = 16) {
    if (jimpMeasureText) {
        try {
            const w = jimpMeasureText(font, text);
            if (Number.isFinite(w) && w > 0) return w;
        } catch { /* fall through */ }
    }
    const map = getCharMap(font);
    if (!map.size) return text.length * fallbackSize * 0.6;

    let w = 0;
    for (const ch of text) {
        const c = map.get(ch) || map.get('?');
        if (!c) continue;
        w += c.xadvance ?? c.width ?? 0;
    }
    return w;
}

function fontLineHeight(font, fallback = 16) {
    return (font && font.common && font.common.lineHeight) ||
        (font && font.lineHeight) ||
        fallback;
}

/**
 * Pick a built-in font for the label.
 *
 * All of `maxW` / `maxH` / `targetPx` must be in the SAME space (either all
 * CSS px or all device px). The caller (renderButton) passes CSS px so the
 * choice is resolution-independent: the same CSS size is picked no matter
 * what `scale` is. The device-size mapping + resampling happens afterwards.
 *
 * We snap to the nearest available size, then walk downward if the text
 * doesn't fit inside maxW x maxH. Custom bitmap fonts are fixed-size and
 * returned as-is.
 */
async function autoFitFont(family, text, maxW, maxH, targetPx) {
    const fam = String(family || 'sans').toLowerCase();
    if (customFonts.has(fam)) return resolveFont(family, targetPx);
    if (!AVAILABLE_SIZES.length) return resolveFont(family, targetPx);

    const desc = [...AVAILABLE_SIZES].sort((a, b) => b - a);

    let start = 0;
    if (Number.isFinite(targetPx) && targetPx > 0) {
        let best = Infinity;
        for (let i = 0; i < desc.length; i++) {
            const d = Math.abs(desc[i] - targetPx);
            if (d < best) { best = d; start = i; }
        }
    }

    for (let i = start; i < desc.length; i++) {
        const s = desc[i];
        const { font } = await resolveFont(family, s);
        // 1px tolerance so Jimp's own measureText can't disagree and force a wrap
        if (measureLine(font, text, s) <= maxW - 1 && fontLineHeight(font, s) <= maxH) {
            return { font, size: s };
        }
    }
    return resolveFont(family, AVAILABLE_SIZES[0]);
}

/* ================================================================== *
 *  2. COLOUR HELPERS
 * ================================================================== */

const NAMED_COLORS = {
    transparent: [0, 0, 0, 0],
    black:   [0, 0, 0, 255],
    white:   [255, 255, 255, 255],
    red:     [255, 0, 0, 255],
    green:   [0, 128, 0, 255],
    lime:    [0, 255, 0, 255],
    blue:    [0, 0, 255, 255],
    yellow:  [255, 255, 0, 255],
    orange:  [255, 165, 0, 255],
    purple:  [128, 0, 128, 255],
    pink:    [255, 192, 203, 255],
    gray:    [128, 128, 128, 255],
    grey:    [128, 128, 128, 255],
    silver:  [192, 192, 192, 255],
    navy:    [0, 0, 128, 255],
    teal:    [0, 128, 128, 255],
    gold:    [255, 215, 0, 255],
};

function parseColor(input, fallback = [0, 0, 0, 255]) {
    if (input == null) return fallback;
    const s = String(input).trim().toLowerCase();
    if (!s) return fallback;
    if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice();

    let m;
    if ((m = /^#?([0-9a-f]{3,4})$/i.exec(s))) {
        const h = m[1];
        return [
            parseInt(h[0] + h[0], 16),
            parseInt(h[1] + h[1], 16),
            parseInt(h[2] + h[2], 16),
            h.length === 4 ? parseInt(h[3] + h[3], 16) : 255,
        ];
    }
    if ((m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s))) {
        const h = m[1];
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
            h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
        ];
    }
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
        const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
            return [
                clamp(parts[0], 0, 255),
                clamp(parts[1], 0, 255),
                clamp(parts[2], 0, 255),
                parts.length > 3 && Number.isFinite(parts[3])
                    ? Math.round(clamp(parts[3], 0, 1) * 255)
                    : 255,
            ];
        }
    }
    return fallback;
}

function mixRgb(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

function shade(color, amt) {
    const target = amt >= 0 ? [255, 255, 255] : [0, 0, 0];
    return mixRgb(color, target, Math.abs(amt));
}

/* ================================================================== *
 *  3. RASTER PRIMITIVES
 * ================================================================== */

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
    r = Math.min(r, hw, hh);
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function blendPixel(img, x, y, r, g, b, a, coverage = 1) {
    const { width, height, data } = img.bitmap;
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const sa = (a / 255) * coverage;
    if (sa <= 0) return;

    const i = (y * width + x) * 4;
    const da = data[i + 3] / 255;
    const outA = sa + da * (1 - sa);

    if (outA <= 0) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
        return;
    }

    data[i]     = Math.round((r * sa + data[i]     * da * (1 - sa)) / outA);
    data[i + 1] = Math.round((g * sa + data[i + 1] * da * (1 - sa)) / outA);
    data[i + 2] = Math.round((b * sa + data[i + 2] * da * (1 - sa)) / outA);
    data[i + 3] = Math.round(outA * 255);
}

/**
 * Paint a rounded rectangle.
 * `hardEdges = true` gives a binary inside/outside test -> crisp pixels.
 */
function paintRoundedRect(img, rect, colorAt, globalAlpha = 1, hardEdges = false) {
    const { x, y, w, h } = rect;
    const r = Math.min(rect.r ?? 0, w / 2, h / 2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hw = w / 2;
    const hh = h / 2;

    const x0 = Math.max(0, Math.floor(x - 2));
    const x1 = Math.min(img.bitmap.width, Math.ceil(x + w + 2));
    const y0 = Math.max(0, Math.floor(y - 2));
    const y1 = Math.min(img.bitmap.height, Math.ceil(y + h + 2));

    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            const d = sdRoundRect(px + 0.5, py + 0.5, cx, cy, hw, hh, r);
            const cov = hardEdges ? (d < 0 ? 1 : 0) : clamp(0.5 - d, 0, 1);
            if (cov <= 0) continue;

            const col = colorAt(px, py, d);
            if (!col) continue;

            const alpha = Math.round((col[3] ?? 255) * globalAlpha);
            blendPixel(img, px, py, col[0], col[1], col[2], alpha, cov);
        }
    }
}

function recolor(img, color, alphaMul = 1) {
    const data = img.bitmap.data;
    const scale = ((color[3] ?? 255) / 255) * alphaMul;
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        if (scale !== 1) data[i + 3] = Math.round(a * scale);
    }
}

/* ================================================================== *
 *  4. BUTTON RENDERING
 * ================================================================== */

const BUTTON_STATES = {
    normal: { lift: 0,  depth: 6, blur: 5, shadow: 0.35, gloss: 0.35, tint: 0 },
    hover:  { lift: -3, depth: 9, blur: 9, shadow: 0.45, gloss: 0.60, tint: 0.12 },
    active: { lift: 5,  depth: 1, blur: 1, shadow: 0.25, gloss: 0.10, tint: -0.10 },
};

// 1x padding reference values. Scaled by `scale` at render time.
const PAD_X = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 34;

async function renderButton(p) {
    const st = BUTTON_STATES[p.state] || BUTTON_STATES.normal;

    const scale = clamp(p.scale, 0.2, 4);
    const lowRes = scale < 1;   // hard edges + no blur

    const baseW = clamp(p.width, 40, 1024);
    const baseH = clamp(p.height, 24, 512);

    // --- everything below is in *device* pixels -------------------
    const width  = Math.max(1, Math.round(baseW * scale));
    const height = Math.max(1, Math.round(baseH * scale));

    let radius = Math.round(clamp(p.radius, 0, Math.min(baseW, baseH) / 2) * scale);
    radius = Math.min(radius, Math.floor(Math.min(width, height) / 2));

    const lift = Math.round((p.lift ?? st.lift) * scale);

    const depthDev = Math.max(0, Math.round((p.depth ?? st.depth) * scale));
    let   blurDev  = Math.max(0, Math.round((p.blur  ?? st.blur)  * scale));
    if (lowRes) blurDev = 0;  // a soft shadow is meaningless at this size

    const borderDev = (p.borderWidth ?? 1.5) * scale;
    const borderWidth = borderDev < 0.5 ? 0 : borderDev;

    const shadowAlpha = p.shadowAlpha ?? st.shadow;
    const gloss = p.gloss ?? st.gloss;

    const padX      = Math.max(2, Math.round(PAD_X * scale));
    const padTop    = Math.max(2, Math.round(PAD_TOP * scale));
    const padBottom = Math.max(2, Math.round(PAD_BOTTOM * scale));

    const canvasW = width + padX * 2;
    const canvasH = height + padTop + padBottom;

    const btnX = padX;
    const btnY = padTop + lift;

    // colours
    const topColor    = shade(p.bg, 0.22 + st.tint);
    const bottomColor = p.bg2 ? p.bg2 : shade(p.bg, -0.20 + st.tint);
    const borderColor = p.border ? p.border : shade(p.bg, -0.45);

    const canvas = new Jimp({ width: canvasW, height: canvasH, color: 0x00000000 });

    /* ---- 1. drop shadow ---- */
    if (shadowAlpha > 0 && depthDev > 0) {
        const shadowLayer = new Jimp({ width: canvasW, height: canvasH, color: 0x00000000 });
        paintRoundedRect(
            shadowLayer,
            { x: btnX, y: btnY + depthDev, w: width, h: height, r: radius },
            () => [p.shadowColor[0], p.shadowColor[1], p.shadowColor[2], 255],
            shadowAlpha,
            lowRes
        );
        if (blurDev > 0) await shadowLayer.blur(blurDev);
        await canvas.composite(shadowLayer, 0, 0);
    }

    /* ---- 2. face: gradient + gloss + rim ---- */
    const bodyLayer = new Jimp({ width: canvasW, height: canvasH, color: 0x00000000 });
    paintRoundedRect(
        bodyLayer,
        { x: btnX, y: btnY, w: width, h: height, r: radius },
        (px, py, d) => {
            const t = clamp((py + 0.5 - btnY) / height, 0, 1);
            let col = mixRgb(topColor, bottomColor, t);

            if (gloss > 0) {
                const g = Math.pow(clamp(1 - t / 0.55, 0, 1), 1.4) * gloss;
                col = mixRgb(col, [255, 255, 255], g);
            }
            if (borderWidth > 0) {
                const bt = clamp(1 + d / borderWidth, 0, 1);
                col = mixRgb(col, borderColor, bt);
            }
            return [col[0], col[1], col[2], 255];
        },
        1,
        lowRes
    );
    await canvas.composite(bodyLayer, 0, 0);

    /* ---- 3. label (resolution-independent size) ----
     *
     * Why two stages? Bitmap fonts only exist at discrete native sizes, and
     * their glyph proportions don't scale linearly. Picking directly in
     * device pixels meant scale 0.5 could stay on a big font while scale 2
     * dropped a size (or vice versa) -> text size fluctuated with resolution.
     *
     * Stage 1 (CSS px, no `scale` involved): pick the logical size S.
     * Stage 2 (device px): render the nearest native font, then resample by
     *   correction = wanted / native so the on-button CSS size is exactly S.
     * Exact matches (the common 0.5x/1x/2x cases) skip resampling entirely.
     */
    const innerPadDev = Math.max(2, Math.round(10 * scale));
    const innerWDev = Math.max(4, width - innerPadDev * 2);
    const innerHDev = Math.max(4, height - Math.round(8 * scale));

    // Stage 1: stable choice in CSS-pixel space.
    const innerWCss = Math.max(4, baseW - 20);
    const innerHCss = Math.max(4, baseH - 8);
    const { font: cssFont, size: cssSize } = await autoFitFont(
        p.font,
        p.text,
        innerWCss,
        innerHCss,
        p.size
    );
    const isCustom = cssSize == null;

    // Stage 2: map to device pixels.
    let printFont = cssFont;   // native font we actually rasterise with
    let nativeW;               // its unscaled text metrics (device px at 1x)
    let nativeH;
    let correction;            // multiply native metrics -> exact device size

    if (!isCustom) {
        const wanted = cssSize * scale;
        const nativeSize = nearestNativeSize(wanted);
        if (nativeSize !== cssSize) {
            ({ font: printFont } = await resolveFont(p.font, nativeSize));
        }
        nativeW = measureLine(printFont, p.text, nativeSize);
        nativeH = fontLineHeight(printFont, nativeSize);
        correction = nativeW > 0 && nativeH > 0 ? wanted / nativeSize : 1;
    } else {
        // Fixed-size custom font: its native pixels ARE the CSS size at 1x.
        // Fit it inside the CSS box (stable), then scale to device pixels.
        nativeW = measureLine(cssFont, p.text, 16);
        nativeH = fontLineHeight(cssFont, 16);
        let fit = 1;
        if (nativeW > 0 && nativeH > 0) {
            fit = Math.min(1, innerWCss / nativeW, innerHCss / nativeH);
        }
        correction = scale * fit;
    }

    if (!Number.isFinite(correction) || correction <= 0) correction = 1;
    // Skip resampling for negligible (<2%) differences: keeps text crisp.
    const needsResample = Math.abs(correction - 1) > 0.02;

    const textWDev = Math.max(1, Math.round(nativeW * correction));
    const textHDev = Math.max(1, Math.round(nativeH * correction));
    const tx = Math.round(btnX + (width - textWDev) / 2);
    const ty = Math.round(btnY + (height - textHDev) / 2);
    const shadowOn = !lowRes;
    const shadowDy = Math.max(1, Math.round(1 * scale));
    const resampleMode = lowRes
        ? ResizeStrategy.NEAREST_NEIGHBOR
        : ResizeStrategy.BILINEAR;

    // Helper: rasterise one text layer. When no resampling is needed we
    // print straight onto a full-canvas layer (crisp fast path); otherwise
    // we print tight and upscale/downscale to the exact device size.
    async function rasteriseText(color, alphaMul, dx, dy) {
        if (!needsResample) {
            const layer = new Jimp({ width: canvasW, height: canvasH, color: 0x00000000 });
            await layer.print({ font: printFont, x: tx + dx, y: ty + dy, text: p.text, maxWidth: innerWDev });
            recolor(layer, color, alphaMul);
            return layer;
        }
        const pad = 4;
        const tight = new Jimp({
            width: Math.max(1, Math.ceil(nativeW) + pad * 2),
            height: Math.max(1, Math.ceil(nativeH) + pad * 2),
            color: 0x00000000,
        });
        await tight.print({ font: printFont, x: pad, y: pad, text: p.text, maxWidth: Math.ceil(nativeW) + pad });
        recolor(tight, color, alphaMul);
        // Crop the padding back off proportionally after scaling.
        const grownW = Math.max(1, Math.round(tight.bitmap.width * correction));
        const grownH = Math.max(1, Math.round(tight.bitmap.height * correction));
        await tight.resize({ w: grownW, h: grownH, mode: resampleMode });
        const off = Math.round(pad * correction);
        const cropped = tight.crop
            ? await tight.crop({ x: off, y: off, w: textWDev, h: textHDev })
            : tight; // older Jimp without .crop({}) — fall back to grown layer
        const layer = new Jimp({ width: canvasW, height: canvasH, color: 0x00000000 });
        await layer.composite(cropped, tx + dx, ty + dy);
        return layer;
    }

    // text drop shadow only makes sense at >= 1x; at low res it just muddies
    if (shadowOn) {
        await canvas.composite(await rasteriseText([0, 0, 0], 0.35, 0, shadowDy), 0, 0);
    }
    await canvas.composite(await rasteriseText(p.fg, 1, 0, 0), 0, 0);

    return canvas;
}

/* ================================================================== *
 *  5. QUERY STRING -> RENDER OPTIONS
 * ================================================================== */

function parseScale(q) {
    // Canonical `scale`, with `resolution` / `res` as aliases so the
    // client-side `data-resolution` attribute maps naturally.
    // Accepts plain numbers ("2"), an "x" suffix ("2x"), or null -> default.
    let raw = q.get('scale');
    if (raw === null || raw === '') raw = q.get('resolution');
    if (raw === null || raw === '') raw = q.get('res');
    if (raw === null || raw === '') return DEFAULT_SCALE;
    const s = String(raw).trim().toLowerCase().replace(/x$/, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : DEFAULT_SCALE;
}

function parseButtonParams(searchParams) {
    const q = searchParams;

    const str = (key, dflt) => {
        const v = q.get(key);
        return v === null || v === '' ? dflt : v;
    };
    const num = (key, dflt) => {
        const v = q.get(key);
        if (v === null || v === '') return dflt;
        const n = Number(v);
        return Number.isFinite(n) ? n : dflt;
    };

    let state = String(str('state', 'normal')).toLowerCase();
    if (state === 'pressed' || state === 'down') state = 'active';
    if (!Object.prototype.hasOwnProperty.call(BUTTON_STATES, state)) state = 'normal';
    if (!q.get('state') && q.get('hover') === '1') state = 'hover';

    return {
        text: String(str('text', 'Button')).slice(0, 200),
        state,

        // resolution: 1 = 1 image px per CSS px. Default is low-res.
        // Accepts `scale` (canonical) plus `resolution` / `res` aliases,
        // with optional "x" suffix ("2x") for convenience.
        scale: parseScale(q),

        // typography
        font: str('font', 'sans'),
        size: num('size', 32),

        // geometry (always expressed in 1x CSS pixels)
        width: num('w', 200),
        height: num('h', 56),
        radius: num('radius', 12),
        borderWidth: num('borderWidth', 1.5),

        // 3D feel (default depends on `state`)
        depth: num('depth', null),
        blur: num('blur', null),
        shadowAlpha: num('shadow', null),
        gloss: num('gloss', null),
        lift: num('lift', null),

        // colours
        bg: parseColor(q.get('bg'), [74, 144, 217, 255]),
        bg2: q.get('bg2') ? parseColor(q.get('bg2'), null) : null,
        fg: parseColor(q.get('fg'), [255, 255, 255, 255]),
        border: q.get('border') ? parseColor(q.get('border'), null) : null,
        shadowColor: parseColor(q.get('shadowColor'), [0, 0, 0, 255]),
    };
}

/* ================================================================== *
 *  6. ROUTES
 * ================================================================== */

async function serveButton(url, res) {
    try {
        const params = parseButtonParams(url.searchParams);
        const image = await renderButton(params);
        const buffer = await image.getBuffer('image/png');

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buffer.length,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(buffer);
    } catch (err) {
        console.error('button render failed:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Failed to render button: ' + err.message);
    }
}

function serveStatic(pathname, res) {
    const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
            res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/button') {
        return serveButton(url, res);
    }

    if (!path.extname(pathname)) {
        pathname = pathname.endsWith('/')
            ? pathname + 'index.html'
            : pathname + '.html';
    }

    serveStatic(pathname, res);
});

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`  default scale: ${DEFAULT_SCALE} (low-res)`);
    console.log(`  built-in font sizes: ${AVAILABLE_SIZES.join(', ') || '(none)'}`);
    if (customFonts.size) {
        console.log(`  custom fonts: ${[...customFonts.keys()].join(', ')}`);
    }
});