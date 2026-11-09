import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { updateNavIndicator } from './navigation.mjs';

function fixture({ selected = true, navLeft = 100, navWidth = 320, buttonLeft = 208, buttonWidth = 96 } = {}) {
  const nav = {
    dataset: { indicatorInitialized:'true' },
    getBoundingClientRect:() => ({ left:navLeft, width:navWidth }),
  };
  const indicator = { style:{
    width:'', transition:'', properties:{},
    setProperty(name,value) { this.properties[name]=value; },
    removeProperty(name) { delete this[name]; },
  } };
  const button = selected ? { getBoundingClientRect:() => ({ left:buttonLeft, width:buttonWidth }) } : null;
  nav.querySelector = selector => selector === '.page-nav-indicator'
    ? indicator
    : selector === '.nav-button[aria-current="page"]' ? button : null;
  const document = {
    querySelector:selector => selector === '.page-nav' ? nav : null,
    defaultView:{ getComputedStyle:() => ({ borderLeftWidth:'1px' }) },
  };
  return { document, nav, indicator };
}

test('selected tab positions a non-interactive highlight at its slot', () => {
  const { document, nav, indicator } = fixture();
  assert.equal(updateNavIndicator(document), true);
  assert.equal(indicator.style.width, '96px');
  assert.equal(indicator.style.properties['--nav-indicator-x'], '107px');
  assert.equal(nav.dataset.indicatorActive, 'true');
});

test('profile view hides the highlight without removing navigation', () => {
  const { document, nav } = fixture({ selected:false });
  assert.equal(updateNavIndicator(document), true);
  assert.equal(nav.dataset.indicatorActive, 'false');
});

test('indicator waits until nav and selected button have measurable geometry', () => {
  const { document } = fixture({ navWidth:0 });
  assert.equal(updateNavIndicator(document), false);
});

test('fixed navigation retains safe-area spacing and the highlight cannot intercept taps', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.page-nav\s*\{[^}]*padding:[^}]*env\(safe-area-inset-bottom\)/s);
  assert.match(css, /\.page-nav-indicator\s*\{[^}]*pointer-events:none/);
});
