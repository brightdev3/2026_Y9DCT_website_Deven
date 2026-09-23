// btn3d.js — builds the three image layers for every .btn3d element.
(function () {
  'use strict';

  // Must match the server's PAD_X / PAD_TOP / PAD_BOTTOM constants.
  const PAD_X = 14;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 34;

  const STATES = ['normal', 'hover', 'active'];

  // Only these data-* keys are forwarded to /button.
  // (Excludes internal keys like btn3dReady, and 'state' which we set ourselves.)
  const PARAM_KEYS = new Set([
    'text', 'scale', 'font', 'size',
    'w', 'h', 'radius', 'borderWidth',
    'depth', 'blur', 'shadow', 'gloss', 'lift',
    'bg', 'bg2', 'fg', 'border', 'shadowColor', 'hover',
  ]);

  function buttonUrl(dataset, state) {
    const params = new URLSearchParams();
    for (const key of PARAM_KEYS) {
      const value = dataset[key];
      if (value != null && value !== '') params.set(key, value);
    }
    params.set('state', state);
    return '/button?' + params.toString();
  }

  function buildButton(btn) {
    if (btn.dataset.btn3dReady === '1') return;

    const w = Number(btn.dataset.w) || 200;
    const h = Number(btn.dataset.h) || 56;
    const r = Number(btn.dataset.radius) || 12;

    // The button element is exactly the face — this is the hit area.
    btn.style.width = w + 'px';
    btn.style.height = h + 'px';
    btn.style.borderRadius = r + 'px';

    // The images are larger and hang outside the button to draw the shadow.
    const fullW = w + PAD_X * 2;
    const fullH = h + PAD_TOP + PAD_BOTTOM;

    for (const state of STATES) {
      const img = new Image();
      img.className = 'btn3d__layer btn3d__layer--' + state;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.src = buttonUrl(btn.dataset, state);

      Object.assign(img.style, {
        position: 'absolute',
        left: -PAD_X + 'px',
        top: -PAD_TOP + 'px',
        width: fullW + 'px',
        height: fullH + 'px',
      });

      btn.appendChild(img);
    }

    btn.dataset.btn3dReady = '1';
  }

  function buildAll(root) {
    const scope = root || document;
    for (const btn of scope.querySelectorAll('.btn3d')) buildButton(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { buildAll(); });
  } else {
    buildAll();
  }

  // Exposed so you can call window.buildButtons() after adding buttons
  // dynamically, e.g. window.buildButtons(someContainer).
  window.buildButtons = buildAll;
})();