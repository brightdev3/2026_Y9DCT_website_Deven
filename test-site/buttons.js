// btn3d.js — builds the three image layers for every .btn3d element.
//
// Resolution (image sharpness) is controlled per-button with an HTML attribute:
//   <button class="btn3d" data-text="Hi" data-resolution="2">…</button>
//
// Accepted values for `data-resolution` (also `data-res`, legacy `data-scale`):
//   - number:            "0.5", "1", "2", "4"   (scale factor, 1 = 1 image px per CSS px)
//   - with "x" suffix:   "0.5x", "1x", "2x"
//   - named preset:      "low" / "retro" (0.5), "medium" (1),
//                        "high" / "retina" (2), "ultra" (3)
// Anything unrecognised falls back to DEFAULT_SCALE.
(function () {
  'use strict';

  // Must match the server's PAD_X / PAD_TOP / PAD_BOTTOM constants (1x values).
  var PAD_X = 14;
  var PAD_TOP = 12;
  var PAD_BOTTOM = 34;

  var STATES = ['normal', 'hover', 'active'];

  var DEFAULT_SCALE = 0.5;
  var MIN_SCALE = 0.2;
  var MAX_SCALE = 4;

  // Friendly names -> scale factor. Keeps HTML readable:
  // data-resolution="low" instead of data-resolution="0.5".
  var RESOLUTION_PRESETS = {
    low: 0.5,
    retro: 0.5,
    pixel: 0.5,
    medium: 1,
    normal: 1,
    standard: 1,
    high: 2,
    retina: 2,
    ultra: 3,
    max: 4,
  };

  // Only these data-* keys are forwarded to /button as-is.
  // ('scale' is set separately from the resolved resolution. 'state',
  // 'resolution' and 'res' are client-side only, as is 'btn3dReady'.)
  var PARAM_KEYS = [
    'text', 'font', 'size',
    'w', 'h', 'radius', 'borderWidth',
    'depth', 'blur', 'shadow', 'gloss', 'lift',
    'bg', 'bg2', 'fg', 'border', 'shadowColor', 'hover',
  ];

  function clamp(value, lo, hi) {
    var n = Number(value);
    if (!isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  // Resolve data-resolution / data-res / data-scale -> numeric scale factor.
  function resolveScale(dataset) {
    var raw = dataset.resolution != null && dataset.resolution !== ''
      ? dataset.resolution
      : dataset.res != null && dataset.res !== ''
        ? dataset.res
        : dataset.scale;

    if (raw == null || raw === '') return DEFAULT_SCALE;

    var s = String(raw).trim().toLowerCase();
    if (RESOLUTION_PRESETS[s] != null) return RESOLUTION_PRESETS[s];

    // Allow "2x", "0.5x".
    if (s.charAt(s.length - 1) === 'x') s = s.slice(0, -1).trim();

    var n = parseFloat(s);
    if (!isFinite(n)) return DEFAULT_SCALE;
    return clamp(n, MIN_SCALE, MAX_SCALE);
  }

  function buttonUrl(dataset, state) {
    var params = new URLSearchParams();
    for (var i = 0; i < PARAM_KEYS.length; i++) {
      var value = dataset[PARAM_KEYS[i]];
      if (value != null && value !== '') params.set(PARAM_KEYS[i], value);
    }
    params.set('scale', String(resolveScale(dataset)));
    params.set('state', state);
    return '/button?' + params.toString();
  }

  // Fingerprint the params that affect rendering, so re-running buildButtons()
  // after a data-* change updates the images instead of duplicating them.
  function fingerprint(btn) {
    var parts = [];
    for (var i = 0; i < PARAM_KEYS.length; i++) parts.push(btn.dataset[PARAM_KEYS[i]] || '');
    parts.push('scale=' + resolveScale(btn.dataset));
    return parts.join('|');
  }

  function styleLayer(img, fullW, fullH) {
    img.style.position = 'absolute';
    img.style.left = -PAD_X + 'px';
    img.style.top = -PAD_TOP + 'px';
    img.style.width = fullW + 'px';
    img.style.height = fullH + 'px';
  }

  function makeLayer(state, src, fullW, fullH) {
    var img = new Image();
    img.className = 'btn3d__layer btn3d__layer--' + state;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    // Decode off the main thread; layers are decorative.
    try { img.decoding = 'async'; } catch (e) { /* older browsers */ }
    styleLayer(img, fullW, fullH);
    img.src = src;
    return img;
  }

  function buildButton(btn) {
    var w = clamp(parseFloat(btn.dataset.w) || 200, 40, 1024);
    var h = clamp(parseFloat(btn.dataset.h) || 56, 24, 512);
    var r = clamp(parseFloat(btn.dataset.radius) || 12, 0, Math.min(w, h) / 2);

    // The button element is exactly the face — this is the hit area.
    btn.style.width = w + 'px';
    btn.style.height = h + 'px';
    btn.style.borderRadius = r + 'px';

    // Fallback label for no-JS / slow image loads (screen readers use aria-label).
    if (!btn.getAttribute('aria-label') && btn.dataset.text) {
      btn.setAttribute('aria-label', btn.dataset.text);
    }

    // The images are larger and hang outside the button to draw the shadow.
    var fullW = w + PAD_X * 2;
    var fullH = h + PAD_TOP + PAD_BOTTOM;
    var key = fingerprint(btn);

    var existing = btn.querySelectorAll('.btn3d__layer');
    if (btn.dataset.btn3dReady === '1' && existing.length === STATES.length) {
      // Already built: only touch the network if something actually changed.
      if (btn.dataset.btn3dKey === key) return;
      for (var i = 0; i < STATES.length; i++) {
        existing[i].src = buttonUrl(btn.dataset, STATES[i]);
        styleLayer(existing[i], fullW, fullH);
      }
      btn.dataset.btn3dKey = key;
      return;
    }

    // First build (or repair a half-built button): clear stale layers, batch insert.
    for (var j = existing.length - 1; j >= 0; j--) existing[j].remove();
    var frag = document.createDocumentFragment();
    for (var k = 0; k < STATES.length; k++) {
      frag.appendChild(makeLayer(STATES[k], buttonUrl(btn.dataset, STATES[k]), fullW, fullH));
    }
    btn.appendChild(frag);

    btn.dataset.btn3dReady = '1';
    btn.dataset.btn3dKey = key;
  }

  function buildAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var btns = scope.querySelectorAll('.btn3d');
    for (var i = 0; i < btns.length; i++) buildButton(btns[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { buildAll(); });
  } else {
    buildAll();
  }

  // Auto-build buttons added later via JS / frameworks.
  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains('btn3d')) {
            buildButton(node);
          } else if (node.querySelectorAll) {
            buildAll(node);
          }
        }
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // Exposed so you can call window.buildButtons() after adding buttons
  // dynamically, or to refresh after changing data-* attributes, e.g.
  //   btn.dataset.resolution = "2";
  //   window.buildButtons();
  window.buildButtons = buildAll;
})();
