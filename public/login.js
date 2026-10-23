const form = document.querySelector('#loginForm');
const err = document.querySelector('#loginErr');
const btn = document.querySelector('#loginBtn');

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
    btn.textContent = 'Entrar';
  }
});
