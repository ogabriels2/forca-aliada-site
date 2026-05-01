const AUTH_STORAGE_KEY = 'fa_auth_users_v1';
const AUTH_SESSION_KEY = 'fa_auth_session_v1';

function seedUsers() {
  const users = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || '[]');
  if (users.length) return;
  const seeded = [
    { username: 'admin', email: '', password: 'NovaAlianca+', role: 'limited', displayName: 'Admin' },
    { username: 'gabalarca', email: 'gabalarcadsmoreira2016@gmail.com', password: 'Famosos1290+', role: 'full', displayName: 'Gabalarca' }
  ];
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(seeded));
}

function getUsers() { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || '[]'); }
function saveUsers(users) { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(users)); }
function getSession() { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || 'null'); }
function setSession(session) { localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session)); }
function logout() { localStorage.removeItem(AUTH_SESSION_KEY); window.location.href = 'login.html'; }

function login(identifier, password) {
  seedUsers();
  const id = (identifier || '').trim().toLowerCase();
  const user = getUsers().find(u => (u.username.toLowerCase() === id || (u.email && u.email.toLowerCase() === id)) && u.password === password);
  if (!user) return { ok: false, message: 'Credenciais inválidas.' };
  setSession({ username: user.username, role: user.role, displayName: user.displayName || user.username });
  return { ok: true, user };
}

function register({ username, email, password }) {
  seedUsers();
  const users = getUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return { ok: false, message: 'Usuário já existe.' };
  users.push({ username, email, password, role: 'limited', displayName: username });
  saveUsers(users);
  return { ok: true };
}

function requireAuth(redirect = 'login.html') {
  const s = getSession();
  if (!s) {
    const next = encodeURIComponent(window.location.pathname.split('/').pop() || 'index.html');
    window.location.href = `${redirect}?next=${next}`;
    return null;
  }
  return s;
}
