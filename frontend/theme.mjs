const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let preference = 'system';

export function normalizeTheme(value) {
  return ['light', 'dark', 'system'].includes(value) ? value : 'system';
}

function applyTheme() {
  const resolved = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#142019' : '#166534');
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
  });
}

export function setTheme(value) {
  preference = normalizeTheme(value);
  applyTheme();
}

export function initTheme(onChange) {
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.addEventListener('click', () => {
      setTheme(button.dataset.themeChoice);
      onChange(preference);
    });
  });
}

systemTheme.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
setTheme('system');
