const API_URL = window.location.origin;

const errorEl = document.getElementById('errorMsg');
const successEl = document.getElementById('successMsg');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');

// Toggle forms
document.getElementById('showRegister')?.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.style.display = 'none';
  registerForm.style.display = 'block';
  clearMessages();
});

document.getElementById('showLogin')?.addEventListener('click', (e) => {
  e.preventDefault();
  registerForm.style.display = 'none';
  loginForm.style.display = 'block';
  clearMessages();
});

function clearMessages() {
  errorEl.textContent = '';
  successEl.textContent = '';
}

// Register
document.getElementById('registerBtn')?.addEventListener('click', async () => {
  clearMessages();
  const name = document.getElementById('registerName').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;

  if (!name || !email || !password) {
    errorEl.textContent = 'All fields required';
    return;
  }

  if (name.length > 20) {
    errorEl.textContent = 'Name must be 20 characters or less';
    return;
  }

  try {
    const res = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Registration failed';
      return;
    }

    successEl.textContent = 'Registration successful! Please login.';
    setTimeout(() => {
      registerForm.style.display = 'none';
      loginForm.style.display = 'block';
      clearMessages();
    }, 1500);
  } catch (err) {
    errorEl.textContent = 'Network error';
    console.error(err);
  }
});

let logoutTimer = null;

function getTokenExpiryMs(token) {
  try {
    const payload = JSON.parse(atob((token || '').split('.')[1] || ''));
    return payload.exp ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

function scheduleLogoutOnExpiry(token) {
  if (logoutTimer) {
    clearTimeout(logoutTimer);
    logoutTimer = null;
  }
  const expMs = getTokenExpiryMs(token);
  if (!expMs) return;
  const delay = Math.max(expMs - Date.now(), 0);
  logoutTimer = setTimeout(() => logout(), delay);
}

// Login
document.getElementById('loginBtn')?.addEventListener('click', async () => {
  clearMessages();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    errorEl.textContent = 'Email and password required';
    return;
  }

  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      return;
    }

    // Store tokens and user info
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    scheduleLogoutOnExpiry(data.accessToken);

    successEl.textContent = 'Login successful! Redirecting...';
    setTimeout(() => {
      window.location.href = 'homepage.html';
    }, 1000);
  } catch (err) {
    errorEl.textContent = 'Network error';
    console.error(err);
  }
});

// Logout function (call from other pages)
function logout() {
  if (logoutTimer) {
    clearTimeout(logoutTimer);
    logoutTimer = null;
  }
  const refreshToken = localStorage.getItem('refreshToken');
  if (refreshToken) {
    fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    }).catch(err => console.error('Logout error', err));
  }
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

// Check if logged in
function isLoggedIn() {
  return !!localStorage.getItem('accessToken');
}

// Get current user
function getCurrentUser() {
  const userStr = localStorage.getItem('user');
  return userStr ? JSON.parse(userStr) : null;
}

// Helper to make authenticated requests
async function authFetch(url, options = {}) {
  let accessToken = localStorage.getItem('accessToken');
  
  options.headers = {
    ...options.headers,
    'Authorization': `Bearer ${accessToken}`
  };

  let res = await fetch(url, options);

  // If 401, try refreshing token
  if (res.status === 401) {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      logout();
      throw new Error('Session expired');
    }

    const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    if (!refreshRes.ok) {
      logout();
      throw new Error('Session expired');
    }

    const refreshData = await refreshRes.json();
    localStorage.setItem('accessToken', refreshData.accessToken);
    localStorage.setItem('refreshToken', refreshData.refreshToken);
    scheduleLogoutOnExpiry(refreshData.accessToken);

    // Retry original request with new token
    options.headers['Authorization'] = `Bearer ${refreshData.accessToken}`;
    res = await fetch(url, options);

    if (res.status === 401) {
      logout();
      throw new Error('Session expired');
    }
  }

  return res;
}

// Start watcher on load if token exists
(() => {
  const existing = localStorage.getItem('accessToken');
  if (existing) scheduleLogoutOnExpiry(existing);
})();
