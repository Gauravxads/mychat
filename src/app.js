import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, doc, setDoc, collection, query, where,
  orderBy, limitToLast, onSnapshot, addDoc, serverTimestamp, increment,
} from 'firebase/firestore';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { firebaseConfig } from './firebase-config.js';

// ---------- In-app updates ----------
// Each GitHub build has a number (baked in at build time). On launch the app asks GitHub
// for the latest release; if it is newer, it offers to download and install it.
const REPO = 'Gauravxads/mychat';
const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 0;
const Updater = registerPlugin('Updater');

const $ = (id) => document.getElementById(id);

// ---------- State ----------
let auth, db;
let me = null;          // my uid
let users = {};         // uid -> {name, email, lastSeen}
let chats = {};         // chatId -> {members, lastMessage, updatedAt, unread, lastRead}
let open = null;        // {id, other, msgs, unsub}
let unsubs = [];
let heartbeat = null;

const chatIdFor = (a, b) => [a, b].sort().join('_');
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : 0);

// ---------- Small UI helpers ----------
function show(screen) {
  for (const s of ['auth', 'home', 'chat']) $(s).hidden = s !== screen;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}
const COLORS = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae'];
function avatar(uid, cls = 'avatar') {
  const name = users[uid]?.name || '?';
  const a = el('div', cls, name.trim()[0]?.toUpperCase() || '?');
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  a.style.background = COLORS[h % COLORS.length];
  if (isOnline(uid)) a.classList.add('online');
  return a;
}
const isOnline = (uid) => Date.now() - ms(users[uid]?.lastSeen) < 90_000;

function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function listTime(t) {
  if (!t) return '';
  const label = dayLabel(t);
  return label === 'Today' ? clock(t) : label;
}
function statusText(uid) {
  if (isOnline(uid)) return 'online';
  const t = ms(users[uid]?.lastSeen);
  if (!t) return '';
  const label = dayLabel(t);
  return `last seen ${label === 'Today' ? 'today' : label === 'Yesterday' ? 'yesterday' : label} at ${clock(t)}`;
}

// ---------- Login / sign up ----------
let signupMode = false;
$('f-toggle').onclick = () => setSignupMode(!signupMode);
function setSignupMode(on) {
  signupMode = on;
  $('f-name').hidden = !signupMode;
  $('f-name').required = signupMode;
  $('f-submit').textContent = signupMode ? 'Create account' : 'Log in';
  $('f-toggle').textContent = signupMode ? 'Already have an account? Log in' : 'New here? Create an account';
  $('f-error').textContent = '';
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/invalid-email': 'That email looks wrong.',
  'auth/email-already-in-use': 'This email already has an account. Log in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/network-request-failed': 'No internet connection.',
  'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
  'auth/operation-not-allowed': 'Email login is not enabled in Firebase (Authentication → Sign-in method).',
  'auth/configuration-not-found': 'Authentication is not enabled in Firebase yet.',
};

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!auth) return;
  const email = $('f-email').value.trim();
  const pass = $('f-pass').value;
  const name = $('f-name').value.trim();
  $('f-error').textContent = '';
  $('f-submit').disabled = true;
  try {
    if (signupMode) {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await setDoc(doc(db, 'users', cred.user.uid), { name, email, lastSeen: serverTimestamp() }, { merge: true });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    $('f-error').textContent = AUTH_ERRORS[err.code] || err.message;
  } finally {
    $('f-submit').disabled = false;
  }
};

$('logout').onclick = () => {
  if (confirm('Log out?')) signOut(auth);
};

// ---------- App start / stop ----------
function onError(err) {
  console.error(err);
  toast(err.code === 'permission-denied'
    ? 'Permission denied. Check the Firestore rules in Firebase.'
    : `Error: ${err.message}`);
}

function ping() {
  if (me && document.visibilityState === 'visible') {
    setDoc(doc(db, 'users', me), { lastSeen: serverTimestamp() }, { merge: true }).catch(onError);
  }
}

function start(user) {
  me = user.uid;
  show('home');
  ping();
  heartbeat = setInterval(() => { ping(); renderList(); if (open) renderHeader(); }, 60_000);

  unsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    users = {};
    snap.forEach((d) => (users[d.id] = d.data({ serverTimestamps: 'estimate' })));
    $('me-name').textContent = users[me]?.name || '';
    renderList();
    if (open) renderHeader();
  }, onError));

  unsubs.push(onSnapshot(query(collection(db, 'chats'), where('members', 'array-contains', me)), (snap) => {
    chats = {};
    snap.forEach((d) => (chats[d.id] = d.data({ serverTimestamps: 'estimate' })));
    renderList();
    if (open) {
      if ((chats[open.id]?.unread?.[me] || 0) > 0) markRead();
      renderMessages(); // other person's read time may have changed (blue ticks)
    }
  }, onError));
}

function stop() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(heartbeat);
  closeChat();
  me = null; users = {}; chats = {};
  $('list').innerHTML = '';
  setSignupMode(false);
  $('f-pass').value = '';
  show('auth');
}

// ---------- Chat list ----------
$('search').oninput = () => renderList();

function renderList() {
  if (!me) return;
  const q = $('search').value.trim().toLowerCase();
  const others = Object.keys(users)
    .filter((uid) => uid !== me && (users[uid].name || '').toLowerCase().includes(q))
    .map((uid) => ({ uid, chat: chats[chatIdFor(me, uid)] }))
    .sort((a, b) => ms(b.chat?.updatedAt) - ms(a.chat?.updatedAt)
      || (users[a.uid].name || '').localeCompare(users[b.uid].name || ''));

  const list = $('list');
  list.innerHTML = '';
  $('empty').hidden = others.length > 0 || q !== '';
  for (const { uid, chat } of others) {
    const unread = chat?.unread?.[me] || 0;
    const row = el('li', 'row');
    row.append(avatar(uid));
    const mid = el('div', 'mid');
    const top = el('div', 'top');
    top.append(el('span', 'name', users[uid].name || 'Unknown'),
      el('span', 'time' + (unread ? ' unread' : ''), listTime(ms(chat?.updatedAt))));
    const bottom = el('div', 'bottom');
    const last = chat?.lastMessage;
    const preview = last ? (last.from === me ? 'You: ' : '') + last.text : 'Tap to chat';
    bottom.append(el('span', 'preview', preview));
    if (unread) bottom.append(el('span', 'badge', unread > 99 ? '99+' : String(unread)));
    mid.append(top, bottom);
    row.append(mid);
    row.onclick = () => openChat(uid);
    list.append(row);
  }
}

// ---------- Conversation ----------
function openChat(other) {
  const id = chatIdFor(me, other);
  open = { id, other, msgs: [], unsub: null };
  show('chat');
  history.pushState({ chat: id }, '');
  renderHeader();
  $('msgs').innerHTML = '';
  open.unsub = onSnapshot(
    query(collection(db, 'chats', id, 'messages'), orderBy('createdAt'), limitToLast(300)),
    (snap) => {
      if (!open || open.id !== id) return;
      open.msgs = snap.docs.map((d) => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) }));
      renderMessages();
    }, onError);
  if (chats[id]) markRead();
  $('text').focus();
}

function closeChat() {
  if (!open) return;
  open.unsub?.();
  open = null;
  $('text').value = '';
  if (me) show('home');
}

$('back').onclick = () => history.back();
window.addEventListener('popstate', () => {
  if (!$('viewer').hidden) { $('viewer').hidden = true; return; }
  closeChat();
});

function renderHeader() {
  const { other } = open;
  $('c-name').textContent = users[other]?.name || 'Unknown';
  $('c-status').textContent = statusText(other);
  $('c-avatar').replaceWith(Object.assign(avatar(other, 'avatar sm'), { id: 'c-avatar' }));
}

function renderMessages() {
  if (!open) return;
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const theyReadAt = ms(chats[open.id]?.lastRead?.[open.other]);
  box.innerHTML = '';
  if (!open.msgs.length) box.append(el('div', 'no-msgs', 'Say hi 👋'));
  let lastDay = '';
  for (const m of open.msgs) {
    const t = ms(m.createdAt);
    const day = dayLabel(t);
    if (day !== lastDay) { box.append(el('div', 'day', day)); lastDay = day; }
    const mine = m.from === me;
    const b = el('div', 'msg ' + (mine ? 'mine' : 'theirs'));
    if (m.image) {
      const img = el('img');
      img.src = m.image;
      img.loading = 'lazy';
      img.onclick = () => openViewer(m.image);
      b.append(img);
    }
    if (m.text) b.append(document.createTextNode(m.text));
    const meta = el('span', 'meta', clock(t));
    if (mine) {
      const read = !m.pending && theyReadAt && t <= theyReadAt;
      meta.append(el('span', 'tick' + (read ? ' read' : ''), m.pending ? '🕓' : read ? '✓✓' : '✓'));
    }
    b.append(meta);
    box.append(b);
  }
  if (nearBottom || open.justSent) box.scrollTop = box.scrollHeight;
  open.justSent = false;
}

function markRead() {
  if (!open || document.visibilityState !== 'visible') return;
  const members = [me, open.other].sort();
  setDoc(doc(db, 'chats', open.id), {
    members,
    unread: { [me]: 0 },
    lastRead: { [me]: serverTimestamp() },
  }, { merge: true }).catch(onError);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { ping(); if (open && chats[open.id]) markRead(); }
});

function send(message, previewText) {
  if (!open) return;
  const { id, other } = open;
  open.justSent = true;
  // Not awaited: Firestore queues writes, so sending works instantly and offline.
  addDoc(collection(db, 'chats', id, 'messages'), { ...message, from: me, createdAt: serverTimestamp() }).catch(onError);
  setDoc(doc(db, 'chats', id), {
    members: [me, other].sort(),
    updatedAt: serverTimestamp(),
    lastMessage: { text: previewText.slice(0, 100), from: me },
    unread: { [other]: increment(1) },
    lastRead: { [me]: serverTimestamp() },
  }, { merge: true }).catch(onError);
}

const textBox = $('text');
textBox.oninput = () => {
  textBox.style.height = 'auto';
  textBox.style.height = textBox.scrollHeight + 'px';
};
$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = textBox.value.trim();
  if (!text) return;
  send({ text }, text);
  textBox.value = '';
  textBox.oninput();
  textBox.focus();
};

// Photos are shrunk and stored inside the message (fits Firebase's free plan; no Storage needed).
async function compressImage(file) {
  const img = await createImageBitmap(file);
  let max = 1280, quality = 0.75;
  const canvas = document.createElement('canvas');
  for (;;) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length < 800_000 || max < 300) return url;
    max = Math.round(max * 0.75);
    quality = Math.max(0.4, quality - 0.1);
  }
}

$('photo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !open) return;
  try {
    const image = await compressImage(file);
    send({ image }, '📷 Photo');
  } catch (err) {
    toast('Could not read that photo.');
    console.error(err);
  }
};

function openViewer(src) {
  $('viewer-img').src = src;
  $('viewer').hidden = false;
  history.pushState({ viewer: true }, '');
}
$('viewer').onclick = () => history.back();

// ---------- Update prompt ----------
async function checkForUpdate() {
  if (!Capacitor.isNativePlatform() || !BUILD) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { cache: 'no-store' });
    if (!res.ok) return;
    const rel = await res.json();
    const latest = parseInt(String(rel.tag_name).replace(/\D/g, ''), 10);
    const apk = (rel.assets || []).find((a) => a.name.endsWith('.apk'));
    if (latest > BUILD && apk) showUpdate(latest, apk.browser_download_url, apk.size);
  } catch (err) {
    console.warn('Update check failed', err);
  }
}

function showUpdate(latest, url, size) {
  const mb = size ? ` (${(size / 1048576).toFixed(1)} MB)` : '';
  $('u-text').textContent = `A new version is ready${mb}. Update now? Your chats are kept.`;
  $('u-bar').hidden = true;
  $('u-pct').textContent = '';
  $('u-later').hidden = false;
  $('u-yes').hidden = false;
  $('u-yes').textContent = 'Update';
  $('u-yes').onclick = () => downloadUpdate(url);
  $('u-later').onclick = () => ($('update').hidden = true);
  $('update').hidden = false;
}

async function downloadUpdate(url) {
  $('u-yes').hidden = true;
  $('u-later').hidden = true;
  $('u-bar').hidden = false;
  $('u-fill').style.width = '0%';
  $('u-text').textContent = 'Downloading update…';
  const listener = await Updater.addListener('progress', ({ loaded, total }) => {
    const pct = total > 0 ? Math.floor((loaded / total) * 100) : null;
    $('u-fill').style.width = (pct ?? 50) + '%';
    $('u-pct').textContent = pct != null ? `${pct}%` : `${(loaded / 1048576).toFixed(1)} MB`;
  });
  try {
    await Updater.download({ url });
    $('u-fill').style.width = '100%';
    $('u-pct').textContent = '100%';
    await installUpdate();
  } catch (err) {
    $('u-text').textContent = `Download failed: ${err.message || err}. Check your internet and try again.`;
    $('u-bar').hidden = true;
    $('u-pct').textContent = '';
    $('u-yes').textContent = 'Retry';
    $('u-yes').onclick = () => downloadUpdate(url);
    $('u-yes').hidden = false;
    $('u-later').hidden = false;
  } finally {
    listener.remove();
  }
}

async function installUpdate() {
  const { needsPermission } = await Updater.install();
  $('u-text').textContent = needsPermission
    ? 'Allow "Install unknown apps" for MyChat in the screen that opened, then come back and tap Install.'
    : 'Tap "Update" in the Android prompt to finish. If nothing opened, tap Install.';
  $('u-yes').textContent = 'Install';
  $('u-yes').onclick = () => installUpdate();
  $('u-yes').hidden = false;
  $('u-later').hidden = false;
}

// ---------- Boot ----------
$('version').textContent = BUILD ? `Version ${BUILD}` : '';
checkForUpdate();
if (firebaseConfig.apiKey.startsWith('PASTE')) {
  show('auth');
  $('setup-msg').hidden = false;
  $('f-submit').disabled = true;
} else {
  const app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  onAuthStateChanged(auth, (user) => (user ? start(user) : stop()));
}
