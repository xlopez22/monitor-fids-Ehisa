const form = document.querySelector('#loginForm');
const err = document.querySelector('#loginErr');
const btn = document.querySelector('#loginBtn');
const pw = form.elements.password;
const togglePw = document.querySelector('#togglePw');

document.querySelector('#year').textContent = new Date().getFullYear();

// Video local de fondo: se intenta reproducir y se funde cuando ya hay imagen.
const video = document.querySelector('#loginVideo');
if (video) {
  const showVideo = () => video.classList.add('is-ready');
  if (video.readyState >= 2) showVideo();
  video.addEventListener('loadeddata', showVideo, { once: true });
  video.addEventListener('playing', showVideo, { once: true });
  const play = () => { const p = video.play(); if (p) p.catch(() => { /* queda el póster */ }); };
  play();
  document.addEventListener('pointerdown', play, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) play(); });
}

// Mostrar / ocultar la contraseña sin salir del campo
togglePw.addEventListener('click', () => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  togglePw.setAttribute('aria-pressed', String(show));
  togglePw.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  pw.focus();
});
pw.addEventListener('input', () => { err.hidden = true; });

// Si ya hay sesión, no tiene sentido mostrar el formulario.
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => { if (s.authenticated) location.replace('/'); })
  .catch(() => { /* si falla, se queda el formulario */ });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Error ${r.status}`);
    }
    location.replace('/');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    form.elements.password.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Iniciar sesión';
  }
});
