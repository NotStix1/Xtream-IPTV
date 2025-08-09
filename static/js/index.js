// index.js - auth
document.addEventListener('DOMContentLoaded', () => {
  const showLogin = document.getElementById('show-login');
  const showRegister = document.getElementById('show-register');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const loginBtn = document.getElementById('login-btn');
  const registerBtn = document.getElementById('register-btn');
  const loginError = document.getElementById('login-error');
  const registerError = document.getElementById('register-error');

  function setTab(tab) {
    [showLogin, showRegister].forEach(b => b.classList.remove('active'));
    if (tab === 'login') {
      showLogin.classList.add('active');
      loginForm.style.display = 'block';
      registerForm.style.display = 'none';
    } else {
      showRegister.classList.add('active');
      loginForm.style.display = 'none';
      registerForm.style.display = 'block';
    }
  }

  showLogin.addEventListener('click', () => setTab('login'));
  showRegister.addEventListener('click', () => setTab('register'));

  loginBtn.addEventListener('click', async () => {
    loginError.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();
    if (!email || !password) { loginError.textContent = 'Enter email & password'; return; }
    try {
      const res = await fetch('/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password})});
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        window.location.href = '/home';
      } else {
        loginError.textContent = data.error || 'Login failed';
      }
    } catch {
      loginError.textContent = 'Network error';
    }
  });

  registerBtn.addEventListener('click', async () => {
    registerError.textContent='';
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value.trim();
    if (!email || !password) { registerError.textContent = 'Enter email & password'; return; }
    try {
      const res = await fetch('/register', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password})});
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('token', data.token);
        window.location.href = '/home';
      } else {
        registerError.textContent = data.error || 'Registration failed';
      }
    } catch {
      registerError.textContent = 'Network error';
    }
  });
});
