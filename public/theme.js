// Tema único de la aplicación: claro por defecto, oscuro solo si el usuario lo
// elige. Se guarda en localStorage y se aplica antes de pintar la página para
// evitar el destello de fondo blanco.
(function () {
  'use strict';

  const KEY = 'fids-theme';
  const root = document.documentElement;
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* sin almacenamiento */ }

  root.classList.toggle('dark', stored === 'dark');

  function current() {
    return root.classList.contains('dark') ? 'dark' : 'light';
  }

  function syncButtons() {
    const dark = current() === 'dark';
    const label = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  function apply(theme) {
    const dark = theme === 'dark';
    root.classList.toggle('dark', dark);
    try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch { /* sin almacenamiento */ }
    syncButtons();
    window.dispatchEvent(new CustomEvent('fids:theme', { detail: { theme: dark ? 'dark' : 'light' } }));
  }

  function toggle() {
    apply(current() === 'dark' ? 'light' : 'dark');
  }

  function bind() {
    syncButtons();
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      if (btn.dataset.themeBound === '1') continue;
      btn.dataset.themeBound = '1';
      btn.addEventListener('click', toggle);
    }
  }

  window.FidsTheme = { apply, toggle, current, bind };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
