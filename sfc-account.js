// ============================================================
// sfc-account.js — user accounts for SchoolFlashCards5
//
// WHAT IT DOES
//   - Username + password accounts (no email collected).
//   - Adds an account button to the header (next to the ⚙️ button)
//     and a dialog for Log in / Sign up / Account / Delete account.
//   - Saves each user's favorites and recently-played games to
//     Firestore at users/{uid}, so they follow the user to any device.
//   - Exposes a tiny API for the page (see the exports at the bottom
//     of the "STATE + API" section): subscribe, toggleFavorite,
//     recordPlay, openAuth, openAccount.
//
// HOW IT'S LOADED
//   games.html loads this with a dynamic import() — NOT a static one —
//   so the games list never depends on this file. If it's missing or
//   fails, the site works exactly like it did before accounts existed.
//
// HOW USERNAMES WORK WITHOUT EMAIL
//   Firebase Auth wants an email-shaped login. We turn the username
//   into "<username>@EMAIL_DOMAIN" behind the scenes. Nothing is ever
//   sent to that address — it's just a unique key. Consequence: there
//   is no "forgot password" email. To help someone who's locked out,
//   delete their user in Firebase console → Authentication → Users so
//   they can sign up again.
//
// REQUIRES (one-time, in Firebase console)
//   - Authentication → Sign-in method → Email/Password enabled
//     (you already have this for the admin panels).
//   - The new firestore.rules published. They're REQUIRED — see the
//     comments in that file for why the old rules aren't safe once
//     visitors can have accounts.
// ============================================================

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, deleteUser, reauthenticateWithCredential, EmailAuthProvider
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyC3jxwyH9Pws4nhIT9ScDffk5CpHa99oMM",
  authDomain: "pinkgame-1d4bf.firebaseapp.com",
  projectId: "pinkgame-1d4bf",
  storageBucket: "pinkgame-1d4bf.firebasestorage.app",
  messagingSenderId: "531941128309",
  appId: "1:531941128309:web:82e55394c6f48666a3603c",
  measurementId: "G-WF5YT7S04W"
};

// Never emailed — see "HOW USERNAMES WORK WITHOUT EMAIL" above.
const EMAIL_DOMAIN = 'users.pinkgame-1d4bf.firebaseapp.com';
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;   // must match firestore.rules
const MIN_PASSWORD = 6;                        // Firebase's own minimum
const MAX_FAVORITES = 300;                     // must match firestore.rules
const MAX_RECENT = 12;                         // rules allow up to 30

// games.html initializes Firebase itself; reuse that app if it exists.
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
const toEmail = (username) => `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
const usernameFromEmail = (email) => String(email || 'player').split('@')[0];

// ============================================================
// STATE + API
// ============================================================
const state = { ready: false, user: null, favorites: [], recent: [] };
const listeners = new Set();

// UI state (declared up here so nothing can reach it before it exists)
let headerBtn = null, overlay = null, panel = null, opener = null;
let mode_ = 'login';     // 'login' | 'signup' | 'account' | 'delete'
let note_ = '';
let toastEl = null, toastTimer = null;

function snapshot() {
  return {
    ready: state.ready,
    loggedIn: !!state.user,
    username: state.user ? state.user.username : null,
    favorites: new Set(state.favorites),
    recent: [...state.recent],
  };
}
function emit() {
  updateHeaderButton();
  const s = snapshot();
  listeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
}

/** Calls fn(snapshot) now and again whenever login state/favorites/recent change. */
export function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

const userRef = () => doc(db, 'users', state.user.uid);

/** Heart toggle. Logged out → opens the login dialog instead. */
export async function toggleFavorite(gameId) {
  if (!state.user) { openAuth('login', 'Log in to save your favorite games ♥'); return; }
  const had = state.favorites.includes(gameId);
  if (!had && state.favorites.length >= MAX_FAVORITES) {
    toast(`You can save up to ${MAX_FAVORITES} favorites.`);
    return;
  }
  const before = state.favorites;
  state.favorites = had ? before.filter(x => x !== gameId) : [...before, gameId];
  emit(); // optimistic: the UI updates instantly, the save happens behind it
  try {
    await updateDoc(userRef(), { favorites: had ? arrayRemove(gameId) : arrayUnion(gameId) });
  } catch (err) {
    console.error('Saving favorite failed:', err);
    state.favorites = before;
    emit();
    toast("Couldn't save that — try again.");
  }
}

/** Call when a game is opened. No-op when logged out. */
export async function recordPlay(gameId) {
  if (!state.user) return;
  state.recent = [gameId, ...state.recent.filter(x => x !== gameId)].slice(0, MAX_RECENT);
  emit();
  try {
    await updateDoc(userRef(), { recent: state.recent });
  } catch (err) {
    console.error('Saving recently played failed:', err); // not worth bothering the user
  }
}

export function openAuth(mode = 'login', note = '') { mode_ = mode; note_ = note; openPanel(); }
export function openAccount() { mode_ = 'account'; note_ = ''; openPanel(); }

// ---- profile loading -----------------------------------------
// applyUser is called from the auth listener AND from signUp/logIn;
// the in-flight cache makes sure the profile is only loaded once.
let inflight = { uid: null, promise: null };
let pendingUsername = null;   // the casing the user typed at sign-up

function applyUser(fbUser) {
  if (inflight.uid === fbUser.uid && inflight.promise) return inflight.promise;
  inflight = { uid: fbUser.uid, promise: loadProfile(fbUser) };
  return inflight.promise;
}

async function loadProfile(fbUser) {
  const ref = doc(db, 'users', fbUser.uid);
  const fallbackName = pendingUsername || usernameFromEmail(fbUser.email);
  let profile = null;
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      profile = snap.data();
    } else {
      // First login after sign-up (or a profile that got lost) — create it.
      profile = { username: fallbackName, favorites: [], recent: [], createdAt: Date.now() };
      await setDoc(ref, profile);
    }
  } catch (err) {
    console.error('Could not load or create the profile:', err);
    toast("Couldn't load your saved games right now.");
    profile = profile || { username: fallbackName, favorites: [], recent: [] };
  }
  pendingUsername = null;
  // Signed out (or switched accounts) while we were loading? Drop it.
  if (!auth.currentUser || auth.currentUser.uid !== fbUser.uid) return;

  state.user = { uid: fbUser.uid, username: String(profile.username || fallbackName) };
  state.favorites = Array.isArray(profile.favorites) ? profile.favorites.filter(x => typeof x === 'string') : [];
  state.recent = Array.isArray(profile.recent) ? profile.recent.filter(x => typeof x === 'string') : [];
  state.ready = true;
  emit();
}

onAuthStateChanged(auth, (fbUser) => {
  if (!fbUser) {
    inflight = { uid: null, promise: null };
    state.user = null; state.favorites = []; state.recent = [];
    state.ready = true;
    emit();
    return;
  }
  applyUser(fbUser);
});

// ---- auth actions --------------------------------------------
async function signUp(username, password) {
  pendingUsername = username;
  try {
    const cred = await createUserWithEmailAndPassword(auth, toEmail(username), password);
    await applyUser(cred.user);
  } catch (err) { pendingUsername = null; throw err; }
}
async function logIn(username, password) {
  const cred = await signInWithEmailAndPassword(auth, toEmail(username), password);
  await applyUser(cred.user);
}
async function logOut() { await signOut(auth); }

async function deleteAccount(password) {
  const u = auth.currentUser;
  if (!u) return;
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, password));
  try { await deleteDoc(doc(db, 'users', u.uid)); } catch (e) { console.error(e); } // best effort
  await deleteUser(u);
}

function friendlyAuthError(err, context) {
  switch (err && err.code) {
    case 'auth/email-already-in-use': return 'That username is already taken — try another one.';
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return context === 'delete' ? "That password isn't right." : 'Wrong username or password.';
    case 'auth/weak-password': return `Password is too weak — use at least ${MIN_PASSWORD} characters.`;
    case 'auth/too-many-requests': return 'Too many tries. Wait a minute and try again.';
    case 'auth/network-request-failed': return "Can't reach the server. Check your connection and try again.";
    case 'auth/operation-not-allowed':
    case 'auth/admin-restricted-operation': return 'Accounts are turned off right now. Try again later.';
    case 'auth/password-does-not-meet-requirements': return "That password isn't strong enough — try a longer one with a mix of characters.";
    case 'auth/user-disabled': return 'This account has been disabled.';
    default:
      console.error(err);
      return 'Something went wrong. Please try again.';
  }
}

// ============================================================
// UI — header button, dialog, toast
// ============================================================
function toast(msg) {
  if (!document.body) return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'sfca-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function injectHeaderButton() {
  const gear = document.querySelector('.settings-btn');
  const host = gear ? gear.parentElement : document.querySelector('.header-right');
  if (!host) return;
  headerBtn = document.createElement('button');
  headerBtn.type = 'button';
  headerBtn.className = 'sfca-btn';
  headerBtn.setAttribute('aria-haspopup', 'dialog');
  headerBtn.addEventListener('click', () => {
    opener = headerBtn;
    state.user ? openAccount() : openAuth('login');
  });
  if (gear) host.insertBefore(headerBtn, gear); else host.appendChild(headerBtn);
  document.documentElement.classList.add('sfca-on'); // scopes the header layout fix below
  updateHeaderButton();
}
function updateHeaderButton() {
  if (!headerBtn) return;
  const label = state.user ? `Account: ${state.user.username}` : 'Log in or sign up';
  headerBtn.textContent = state.user ? state.user.username.charAt(0).toUpperCase() : '👤';
  headerBtn.classList.toggle('in', !!state.user);
  headerBtn.title = label;
  headerBtn.setAttribute('aria-label', label);
}

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.className = 'sfca-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<div class="sfca-panel" role="dialog" aria-modal="true" aria-labelledby="sfcaTitle"></div>';
  panel = overlay.firstChild;
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePanel(); });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('sfca-close')) { closePanel(); return; }
    if (btn.dataset.mode) {
      const typed = panel.querySelector('[name="username"]');
      const keep = typed ? typed.value : '';
      mode_ = btn.dataset.mode;
      renderPanel();
      const again = panel.querySelector('[name="username"]');
      if (again && keep) again.value = keep;
      return;
    }
    if (btn.dataset.action === 'logout') {
      logOut().then(() => { closePanel(); toast('Logged out.'); }).catch(() => toast("Couldn't log out \u2014 try again."));
    } else if (btn.dataset.action === 'to-delete') {
      mode_ = 'delete'; renderPanel();
    } else if (btn.dataset.action === 'cancel-delete') {
      mode_ = 'account'; renderPanel();
    }
  });

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.kind === 'delete') submitDelete(form); else submitAuth(form);
  });

  document.addEventListener('keydown', (e) => {
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
    if (e.key !== 'Tab') return;
    const f = [...panel.querySelectorAll('button, input')].filter(el => !el.disabled);
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function openPanel() {
  if (!overlay) buildOverlay();
  if (!opener) opener = document.activeElement;
  renderPanel();
  overlay.hidden = false;
  document.documentElement.style.overflow = 'hidden';
  const target = panel.querySelector('input') || panel.querySelector('.sfca-primary') || panel.querySelector('button');
  if (target) target.focus();
}
function closePanel() {
  if (!overlay) return;
  overlay.hidden = true;
  document.documentElement.style.overflow = '';
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
}

function renderPanel() {
  if (mode_ === 'account' && !state.user) mode_ = 'login';
  if (mode_ === 'account') return renderAccount();
  if (mode_ === 'delete') return renderDelete();
  renderAuth();
  if (panel.querySelector('input')) panel.querySelector('input').focus();
}

const CLOSE_BTN = '<button type="button" class="sfca-close" aria-label="Close">\u00d7</button>';

function renderAuth() {
  const signup = mode_ === 'signup';
  panel.innerHTML = `
    <div class="sfca-head"><h2 id="sfcaTitle">${signup ? 'Create an account' : 'Log in'}</h2>${CLOSE_BTN}</div>
    ${note_ ? `<p class="sfca-note">${esc(note_)}</p>` : ''}
    <div class="sfca-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${!signup}" data-mode="login" class="${!signup ? 'on' : ''}">Log in</button>
      <button type="button" role="tab" aria-selected="${signup}" data-mode="signup" class="${signup ? 'on' : ''}">Sign up</button>
    </div>
    <form class="sfca-form" data-kind="auth" novalidate>
      <label class="sfca-field">Username
        <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required>
      </label>
      <label class="sfca-field">Password
        <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
      </label>
      ${signup ? `
      <label class="sfca-field">Confirm password
        <input name="confirm" type="password" autocomplete="new-password" required>
      </label>
      <p class="sfca-hint">No email needed. Pick a username (3\u201320 letters, numbers or _) and please don't use your real name. We can't reset passwords, so remember it!</p>` : ''}
      <p class="sfca-error" role="alert"></p>
      <button type="submit" class="sfca-primary">${signup ? 'Create account' : 'Log in'}</button>
    </form>`;
}

function renderAccount() {
  panel.innerHTML = `
    <div class="sfca-head"><h2 id="sfcaTitle">Hi, ${esc(state.user.username)}! \ud83d\udc4b</h2>${CLOSE_BTN}</div>
    <p class="sfca-note">Your favorites \u2665 and recently played games are saved to this account, on any device you log in from.</p>
    <div class="sfca-actions">
      <button type="button" class="sfca-primary" data-action="logout">Log out</button>
      <button type="button" class="sfca-secondary sfca-warn" data-action="to-delete">Delete account</button>
    </div>`;
}

function renderDelete() {
  panel.innerHTML = `
    <div class="sfca-head"><h2 id="sfcaTitle">Delete account?</h2>${CLOSE_BTN}</div>
    <p class="sfca-note">This permanently deletes <b>${esc(state.user.username)}</b> along with your favorites and history. It can't be undone. Enter your password to confirm.</p>
    <form class="sfca-form" data-kind="delete" novalidate>
      <label class="sfca-field">Password
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <p class="sfca-error" role="alert"></p>
      <div class="sfca-actions">
        <button type="button" class="sfca-secondary" data-action="cancel-delete">Cancel</button>
        <button type="submit" class="sfca-danger">Delete forever</button>
      </div>
    </form>`;
}

function setBusy(btn, busy, busyText) {
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = busyText; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

async function submitAuth(form) {
  const signup = mode_ === 'signup';
  const username = form.elements['username'].value.trim();
  const password = form.elements['password'].value;
  const errEl = form.querySelector('.sfca-error');
  const submit = form.querySelector('button[type="submit"]');
  errEl.textContent = '';

  if (!USERNAME_RE.test(username)) { errEl.textContent = 'Usernames are 3\u201320 characters: letters, numbers or underscore.'; return; }
  if (password.length < MIN_PASSWORD) { errEl.textContent = `Password must be at least ${MIN_PASSWORD} characters.`; return; }
  if (signup && password !== form.elements['confirm'].value) { errEl.textContent = "Passwords don't match."; return; }

  setBusy(submit, true, signup ? 'Creating\u2026' : 'Logging in\u2026');
  try {
    if (signup) await signUp(username, password); else await logIn(username, password);
    const name = state.user ? state.user.username : username;
    closePanel();
    toast(signup ? `Welcome, ${name}!` : `Welcome back, ${name}!`);
  } catch (err) {
    errEl.textContent = friendlyAuthError(err, signup ? 'signup' : 'login');
    setBusy(submit, false);
  }
}

async function submitDelete(form) {
  const password = form.elements['password'].value;
  const errEl = form.querySelector('.sfca-error');
  const submit = form.querySelector('button[type="submit"]');
  errEl.textContent = '';
  if (!password) { errEl.textContent = 'Enter your password to confirm.'; return; }
  setBusy(submit, true, 'Deleting\u2026');
  try {
    await deleteAccount(password);
    closePanel();
    toast('Your account was deleted.');
  } catch (err) {
    errEl.textContent = friendlyAuthError(err, 'delete');
    setBusy(submit, false);
  }
}

// ---- styles (matches the site's teal / yellow / coral + dark mode) ----
function injectStyles() {
  const css = `
.game-card{position:relative}
/* Header room: one more button means the header row can overflow. Its two groups are flex-shrink:0 and
   the row never wrapped, so on mid-size screens (~770-1290px) the right edge (the buttons!) fell off-screen
   - something the page already did for the gear below ~1260px before accounts existed. */
@media (min-width:769px){
  /* tighten the right-hand group a little so the new button costs no net width... */
  html.sfca-on .header-right{margin-left:auto;gap:12px}
  html.sfca-on .header-search{width:200px}
  /* ...and wrap (instead of spilling off-screen) only when the window is genuinely narrow */
  html.sfca-on .header-content{flex-wrap:wrap;row-gap:12px}
}
@media (max-width:768px){
  html.sfca-on .header-search{max-width:240px} /* keeps search + 👤 + ⚙️ on one row on phones */
}
.sfca-btn{width:38px;height:38px;padding:0;border:none;border-radius:50%;background:#292F36;color:#FFE66D;font:bold 17px/1 "Comic Sans MS",cursive,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;user-select:none;transition:transform .2s,background-color .3s}
.sfca-btn:hover{background:#454545;transform:scale(1.1)}
.sfca-btn:focus-visible{outline:3px solid #FFE66D;outline-offset:2px}
.sfca-btn.in{background:#FFE66D;color:#292F36}
.sfca-btn.in:hover{background:#ffd93d}
html[data-theme="dark"] .sfca-btn{background:#3a3f47}
html[data-theme="dark"] .sfca-btn:hover{background:#50565f}
html[data-theme="dark"] .sfca-btn.in{background:#FFE66D;color:#14181d}

.sfca-fav{position:absolute;top:8px;right:8px;z-index:2;width:34px;height:34px;padding:0;border:none;border-radius:50%;background:rgba(255,255,255,.9);color:#FF6B6B;font-size:19px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 5px rgba(0,0,0,.35);transition:transform .15s,background-color .15s}
.sfca-fav:hover{transform:scale(1.15)}
.sfca-fav.on{background:#FF6B6B;color:#fff}
.sfca-fav:focus-visible{outline:3px solid #FFE66D;outline-offset:2px}

.sfca-viewtabs{display:flex;justify-content:center;flex-wrap:wrap;gap:10px;margin:-12px 0 28px}
.sfca-viewtabs[hidden]{display:none}
.sfca-chip{background:#fff;border:2px solid #4ECDC4;color:#292F36;padding:8px 16px;border-radius:20px;font:bold 14px "Comic Sans MS",cursive,sans-serif;cursor:pointer;transition:background-color .2s,color .2s}
.sfca-chip:hover,.sfca-chip.active{background:#4ECDC4;color:#fff}
.sfca-chip:focus-visible{outline:3px solid #FF6B6B;outline-offset:2px}
html[data-theme="dark"] .sfca-chip{background:#1f252c;color:#e8ecef}
html[data-theme="dark"] .sfca-chip:hover,html[data-theme="dark"] .sfca-chip.active{background:#4ECDC4;color:#14181d}

.sfca-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5);font-family:"Comic Sans MS",cursive,sans-serif}
.sfca-overlay[hidden]{display:none}
.sfca-overlay *{font-family:inherit;box-sizing:border-box}
.sfca-panel{width:100%;max-width:380px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#292F36;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:18px 20px 20px;text-align:left}
.sfca-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sfca-head h2{font-size:22px;margin:0;color:inherit}
.sfca-close{width:32px;height:32px;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;font-size:22px;line-height:1;cursor:pointer;flex-shrink:0}
.sfca-close:hover{background:rgba(128,128,128,.2)}
.sfca-note{margin:10px 0 0;font-size:14px;line-height:1.45;opacity:.85}
.sfca-tabs{display:flex;gap:6px;margin:14px 0 2px;padding:4px;background:#eef2f5;border-radius:12px}
.sfca-tabs button{flex:1;padding:9px 0;border:none;border-radius:9px;background:transparent;color:#5b6670;font-size:15px;font-weight:bold;cursor:pointer}
.sfca-tabs button.on{background:#4ECDC4;color:#fff}
.sfca-field{display:block;margin-top:12px;font-size:14px;font-weight:bold}
.sfca-field input{display:block;width:100%;margin-top:5px;padding:10px 12px;border:2px solid #d5dde3;border-radius:10px;background:#fff;color:#292F36;font-size:16px;outline:none}
.sfca-field input:focus{border-color:#4ECDC4}
.sfca-hint{margin:10px 0 0;font-size:12.5px;line-height:1.45;opacity:.75}
.sfca-error{min-height:20px;margin:10px 0 0;color:#c0392b;font-size:14px;font-weight:bold}
.sfca-primary,.sfca-secondary,.sfca-danger{display:block;width:100%;margin-top:6px;padding:12px;border-radius:10px;font-size:16px;font-weight:bold;cursor:pointer;transition:background-color .2s}
.sfca-primary{border:none;background:#FF6B6B;color:#fff}
.sfca-primary:hover{background:#e85555}
.sfca-secondary{border:2px solid #cfd8de;background:transparent;color:inherit}
.sfca-secondary:hover{background:rgba(128,128,128,.12)}
.sfca-warn{border-color:#e6b0aa;color:#c0392b}
.sfca-danger{border:none;background:#c0392b;color:#fff}
.sfca-danger:hover{background:#a93226}
.sfca-primary:disabled,.sfca-danger:disabled{opacity:.6;cursor:wait}
.sfca-actions{display:flex;gap:10px;margin-top:14px}
.sfca-actions>button{flex:1;width:auto;margin-top:0}
.sfca-primary:focus-visible,.sfca-secondary:focus-visible,.sfca-danger:focus-visible,.sfca-tabs button:focus-visible,.sfca-close:focus-visible{outline:3px solid #FFE66D;outline-offset:2px}
html[data-theme="dark"] .sfca-panel{background:#1f252c;color:#e8ecef;box-shadow:0 12px 40px rgba(0,0,0,.7)}
html[data-theme="dark"] .sfca-tabs{background:#14181d}
html[data-theme="dark"] .sfca-tabs button{color:#9aa4ad}
html[data-theme="dark"] .sfca-tabs button.on{background:#4ECDC4;color:#14181d}
html[data-theme="dark"] .sfca-field input{background:#14181d;border-color:#3a434d;color:#e8ecef}
html[data-theme="dark"] .sfca-field input:focus{border-color:#4ECDC4}
html[data-theme="dark"] .sfca-error{color:#ff8a80}
html[data-theme="dark"] .sfca-secondary{border-color:#3a434d}
html[data-theme="dark"] .sfca-warn{border-color:#7a3b36;color:#ff8a80}

.sfca-toast{position:fixed;left:50%;bottom:24px;z-index:10002;transform:translate(-50%,20px);max-width:calc(100vw - 32px);padding:10px 18px;border-radius:999px;background:#292F36;color:#fff;font:bold 14px "Comic Sans MS",cursive,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
.sfca-toast.show{opacity:1;transform:translate(-50%,0)}
html[data-theme="dark"] .sfca-toast{background:#4ECDC4;color:#14181d}
@media (prefers-reduced-motion:reduce){.sfca-btn,.sfca-fav,.sfca-toast{transition:none}}
`;
  const style = document.createElement('style');
  style.id = 'sfca-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function init() { injectStyles(); injectHeaderButton(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
