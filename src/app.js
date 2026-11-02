import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, doc, setDoc, collection, query, where,
  orderBy, limitToLast, endBefore, getDoc, getDocs, onSnapshot, addDoc, serverTimestamp, increment,
  deleteDoc, writeBatch,
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
let users = {};         // uid -> {name, email, code, lastSeen} — me + my contacts (+ everyone for admins)
let contacts = new Set(); // uids of approved contacts
let incoming = [];      // invites sent to me
let outgoing = [];      // invites I sent
let profileSubs = new Map(); // uid -> unsubscribe, live profile of each contact
let chats = {};         // chatId -> {members, lastMessage, updatedAt, unread, lastRead}
let open = null;        // {id, other, msgs, unsub}
let unsubs = [];
let heartbeat = null;

const chatIdFor = (a, b) => [a, b].sort().join('_');
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : 0);

// ---------- Small UI helpers ----------
function show(screen) {
  for (const s of ['auth', 'home', 'requests', 'admin', 'chat']) $(s).hidden = s !== screen;
}
let adminUsers = {}; // every profile, loaded only while an admin has the Admin screen open
const nameOf = (uid) => users[uid]?.name || adminUsers[uid]?.name || 'Unknown';
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
  const name = nameOf(uid);
  const a = el('div', cls, name === 'Unknown' ? '?' : name.trim()[0]?.toUpperCase() || '?');
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
      // The unique ID is created by ensureCode() once the profile loads.
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

  // My own profile (name + unique ID)
  unsubs.push(onSnapshot(doc(db, 'users', me), (d) => {
    users[me] = d.data({ serverTimestamps: 'estimate' }) || {};
    $('me-name').textContent = users[me].name || '';
    $('me-code').textContent = users[me].code || '…';
    if (d.exists() && !users[me].code) ensureCode();
  }, onError));

  // Approved contacts: users/<me>/contacts/<uid>
  unsubs.push(onSnapshot(collection(db, 'users', me, 'contacts'), (snap) => {
    contacts = new Set(snap.docs.map((d) => d.id));
    syncProfiles();
    renderList();
    if (open && !open.admin && !contacts.has(open.other)) {
      toast(`${nameOf(open.other)} is no longer in your contacts.`);
      history.back();
    }
  }, onError));

  // Contact requests, both directions
  unsubs.push(onSnapshot(query(collection(db, 'invites'), where('to', '==', me)), (snap) => {
    incoming = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
    renderRequests();
  }, onError));
  unsubs.push(onSnapshot(query(collection(db, 'invites'), where('from', '==', me)), (snap) => {
    outgoing = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
    renderRequests();
  }, onError));

  unsubs.push(onSnapshot(query(collection(db, 'chats'), where('members', 'array-contains', me)), (snap) => {
    chats = {};
    snap.forEach((d) => (chats[d.id] = d.data({ serverTimestamps: 'estimate' })));
    renderList();
    if (open) {
      if (!open.admin && (chats[open.id]?.unread?.[me] || 0) > 0) markRead();
      renderMessages(); // other person's read time may have changed (blue ticks)
    }
  }, onError));

  // Admin accounts are marked by a document admins/<uid>, created only from the Firebase console.
  getDoc(doc(db, 'admins', me))
    .then((d) => { if (me === user.uid) $('admin-btn').hidden = !d.exists(); })
    .catch(() => {});
}

function stop() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(heartbeat);
  closeChat();
  leaveAdmin();
  profileSubs.forEach((u) => u());
  profileSubs = new Map();
  $('admin-btn').hidden = true;
  $('add-modal').hidden = true;
  me = null; users = {}; chats = {}; contacts = new Set(); incoming = []; outgoing = [];
  ensuringCode = false;
  $('list').innerHTML = '';
  renderRequests();
  setSignupMode(false);
  $('f-pass').value = '';
  show('auth');
}

// ---------- Unique ID ----------
// 6 characters, no look-alikes (0/O, 1/I). codes/<ID> -> {uid}; the rules only allow creating an ID that is free.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let ensuringCode = false;
async function ensureCode() {
  if (ensuringCode) return;
  ensuringCode = true;
  const uid = me;
  try {
    for (let i = 0; i < 6 && me === uid; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const code = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      try {
        await setDoc(doc(db, 'codes', code), { uid });
      } catch (err) {
        if (err.code === 'permission-denied') continue; // already taken, try another
        throw err;
      }
      await setDoc(doc(db, 'users', uid), { code }, { merge: true });
      return;
    }
  } catch (err) {
    onError(err);
  } finally {
    ensuringCode = false;
  }
}

$('copy-code').onclick = async () => {
  const code = users[me]?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Your ID ${code} is copied. Send it to a friend so they can add you.`);
  } catch {
    toast(`Your ID is ${code}`);
  }
};

// Live name / online status for each contact
function syncProfiles() {
  for (const uid of contacts) {
    if (profileSubs.has(uid)) continue;
    profileSubs.set(uid, onSnapshot(doc(db, 'users', uid), (d) => {
      if (!contacts.has(uid)) return;
      users[uid] = d.data({ serverTimestamps: 'estimate' }) || {};
      renderList();
      if (open?.other === uid) renderHeader();
    }, onError));
  }
  for (const [uid, unsub] of profileSubs) {
    if (contacts.has(uid)) continue;
    unsub();
    profileSubs.delete(uid);
    if (uid !== me) delete users[uid];
  }
}

// ---------- Add contact (by ID) ----------
$('add-btn').onclick = () => {
  $('add-code').value = '';
  $('add-error').textContent = '';
  $('add-modal').hidden = false;
  $('add-code').focus();
};
$('add-cancel').onclick = () => ($('add-modal').hidden = true);
$('add-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('add-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fail = (msg) => ($('add-error').textContent = msg);
  if (code.length !== 6) return fail('An ID has 6 letters/numbers, like K7Q2MX.');
  if (code === users[me]?.code) return fail("That's your own ID.");
  $('add-send').disabled = true;
  fail('');
  try {
    const c = await getDoc(doc(db, 'codes', code));
    if (!c.exists()) return fail('No one has this ID. Check it and try again.');
    const uid = c.data().uid;
    if (contacts.has(uid)) return fail('Already in your contacts.');
    const theirs = incoming.find((i) => i.from === uid);
    if (theirs) { // they already asked me: just approve
      await acceptInvite(theirs);
      $('add-modal').hidden = true;
      return;
    }
    if (outgoing.some((i) => i.to === uid)) return fail('Request already sent. Waiting for them to approve.');
    const them = await getDoc(doc(db, 'users', uid));
    await setDoc(doc(db, 'invites', `${me}_${uid}`), {
      from: me, to: uid,
      fromName: users[me]?.name || '', fromCode: users[me]?.code || '',
      toName: them.data()?.name || '', toCode: code,
      createdAt: serverTimestamp(),
    });
    $('add-modal').hidden = true;
    toast(`Request sent to ${them.data()?.name || code}. They'll appear here once they approve.`);
  } catch (err) {
    fail(err.code === 'permission-denied' ? 'Could not send the request.' : err.message);
  } finally {
    $('add-send').disabled = false;
  }
};

// ---------- Requests (bell) ----------
$('bell').onclick = () => {
  show('requests');
  history.pushState({ requests: true }, '');
};
$('r-back').onclick = () => history.back();

async function acceptInvite(inv) {
  // One batch: add each other as contacts and remove the request.
  const b = writeBatch(db);
  b.set(doc(db, 'users', me, 'contacts', inv.from), { since: serverTimestamp() });
  b.set(doc(db, 'users', inv.from, 'contacts', me), { since: serverTimestamp() });
  b.delete(doc(db, 'invites', inv.id));
  await b.commit();
  toast(`${inv.fromName || 'Contact'} added to your chats.`);
}

function requestRow(name, code, buttons) {
  const row = el('li', 'req');
  const info = el('div', 'req-info');
  info.append(el('div', 'name', name || 'Unknown'), el('div', 'preview', `ID ${code || '—'}`));
  row.append(info, ...buttons);
  return row;
}
function smallBtn(label, cls, fn) {
  const b = el('button', 'sm-btn ' + cls, label);
  b.type = 'button';
  b.onclick = async () => {
    b.disabled = true;
    try { await fn(); } catch (err) { onError(err); b.disabled = false; }
  };
  return b;
}

function renderRequests() {
  const n = incoming.length;
  $('bell-badge').hidden = n === 0;
  $('bell-badge').textContent = n > 9 ? '9+' : String(n);
  const inList = $('r-in'), outList = $('r-out');
  inList.innerHTML = '';
  outList.innerHTML = '';
  for (const inv of incoming) {
    inList.append(requestRow(inv.fromName, inv.fromCode, [
      smallBtn('Reject', 'ghost', () => deleteDoc(doc(db, 'invites', inv.id))),
      smallBtn('Approve', 'solid', () => acceptInvite(inv)),
    ]));
  }
  for (const inv of outgoing) {
    outList.append(requestRow(inv.toName, inv.toCode, [
      el('span', 'pending', 'Pending'),
      smallBtn('Cancel', 'ghost', () => deleteDoc(doc(db, 'invites', inv.id))),
    ]));
  }
  $('r-in-empty').hidden = incoming.length > 0;
  $('r-out-empty').hidden = outgoing.length > 0;
}

// ---------- Remove contact ----------
$('c-remove').onclick = async () => {
  if (!open || open.admin) return;
  const other = open.other;
  if (!confirm(`Remove ${nameOf(other)} from your contacts? You will both need to send a new request to chat again.`)) return;
  const b = writeBatch(db);
  b.delete(doc(db, 'users', me, 'contacts', other));
  b.delete(doc(db, 'users', other, 'contacts', me));
  try { await b.commit(); } catch (err) { onError(err); }
};

// ---------- Chat list ----------
$('search').oninput = () => renderList();

function renderList() {
  if (!me) return;
  const q = $('search').value.trim().toLowerCase();
  const others = [...contacts]
    .filter((uid) => uid !== me && nameOf(uid).toLowerCase().includes(q))
    .map((uid) => ({ uid, chat: chats[chatIdFor(me, uid)] }))
    .sort((a, b) => ms(b.chat?.updatedAt) - ms(a.chat?.updatedAt)
      || nameOf(a.uid).localeCompare(nameOf(b.uid)));

  const list = $('list');
  list.innerHTML = '';
  $('empty').hidden = others.length > 0 || q !== '';
  for (const { uid, chat } of others) {
    const unread = chat?.unread?.[me] || 0;
    const row = el('li', 'row');
    row.append(avatar(uid));
    const mid = el('div', 'mid');
    const top = el('div', 'top');
    top.append(el('span', 'name', nameOf(uid)),
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
// Messages load in pages: the newest PAGE live, then PAGE older ones each time you scroll to the top.
const PAGE = 50;

function storeDoc(d) {
  open.byId.set(d.id, { id: d.id, snap: d, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) });
}
function sortedMsgs() {
  return [...open.byId.values()].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
}

// ---------- Admin: all conversations (read-only) ----------
let adminChats = {};
let adminUnsubs = [];

$('admin-btn').onclick = () => {
  show('admin');
  history.pushState({ admin: true }, '');
  leaveAdmin();
  adminUnsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    adminUsers = {};
    snap.forEach((d) => (adminUsers[d.id] = d.data({ serverTimestamps: 'estimate' })));
    renderAdminList();
    if (open?.admin) { renderHeader(); renderMessages(); }
  }, onError));
  adminUnsubs.push(onSnapshot(query(collection(db, 'chats'), orderBy('updatedAt', 'desc')), (snap) => {
    adminChats = {};
    snap.forEach((d) => (adminChats[d.id] = d.data({ serverTimestamps: 'estimate' })));
    renderAdminList();
    if (open?.admin) renderMessages();
  }, onError));
};

function leaveAdmin() {
  adminUnsubs.forEach((u) => u());
  adminUnsubs = [];
  adminChats = {};
  adminUsers = {};
  $('a-list').innerHTML = '';
}

function renderAdminList() {
  const list = $('a-list');
  list.innerHTML = '';
  const ids = Object.keys(adminChats);
  $('a-empty').hidden = ids.length > 0;
  $('a-count').textContent = `${ids.length} chat${ids.length === 1 ? '' : 's'} · ${Object.keys(adminUsers).length} users`;
  for (const id of ids) {
    const c = adminChats[id];
    const [a, b] = c.members || id.split('_');
    const row = el('li', 'row');
    row.append(avatar(a));
    const mid = el('div', 'mid');
    const top = el('div', 'top');
    top.append(el('span', 'name', `${nameOf(a)} ↔ ${nameOf(b)}`), el('span', 'time', listTime(ms(c.updatedAt))));
    const bottom = el('div', 'bottom');
    const last = c.lastMessage;
    bottom.append(el('span', 'preview', last ? `${nameOf(last.from)}: ${last.text}` : ''));
    mid.append(top, bottom);
    row.append(mid);
    row.onclick = () => openChat(b, { adminChatId: id, viewer: a });
    list.append(row);
  }
}

// Normal chat: openChat(otherUid). Admin view: openChat(uidB, { adminChatId, viewer: uidA }) — read-only.
function openChat(other, { adminChatId = null, viewer = me } = {}) {
  const id = adminChatId || chatIdFor(me, other);
  // byId keeps every message seen so far, so ones that scroll out of the live window are not lost.
  open = { id, other, viewer, admin: !!adminChatId, byId: new Map(), msgs: [], unsub: null, hasMore: true, loadingOlder: false };
  $('composer').hidden = open.admin;
  show('chat');
  history.pushState({ chat: id }, '');
  renderHeader();
  $('msgs').innerHTML = '';
  let first = true;
  open.unsub = onSnapshot(
    query(collection(db, 'chats', id, 'messages'), orderBy('createdAt'), limitToLast(PAGE)),
    (snap) => {
      if (!open || open.id !== id) return;
      snap.docs.forEach(storeDoc);
      if (first) { open.hasMore = snap.docs.length >= PAGE; first = false; }
      open.msgs = sortedMsgs();
      renderMessages();
    }, onError);
  if (!open.admin) {
    if (chats[id]) markRead();
    $('text').focus();
  }
}

async function loadOlder() {
  if (!open || open.loadingOlder || !open.hasMore) return;
  const oldest = open.msgs.find((m) => !m.pending);
  if (!oldest) return;
  const chat = open;
  chat.loadingOlder = true;
  renderMessages();
  try {
    const snap = await getDocs(query(collection(db, 'chats', chat.id, 'messages'),
      orderBy('createdAt'), endBefore(oldest.snap), limitToLast(PAGE)));
    if (open !== chat) return;
    snap.docs.forEach(storeDoc);
    chat.hasMore = snap.docs.length >= PAGE;
    chat.msgs = sortedMsgs();
  } catch (err) {
    onError(err);
  } finally {
    chat.loadingOlder = false;
    if (open === chat) renderMessages({ keepPosition: true });
  }
}

$('msgs').addEventListener('scroll', () => {
  if ($('msgs').scrollTop < 150) loadOlder();
});

function closeChat() {
  if (!open) return;
  const wasAdmin = open.admin;
  open.unsub?.();
  open = null;
  $('text').value = '';
  $('composer').hidden = false;
  if (me) show(wasAdmin ? 'admin' : 'home');
}

$('back').onclick = () => history.back();
$('a-back').onclick = () => history.back();
window.addEventListener('popstate', () => {
  if (!$('viewer').hidden) { $('viewer').hidden = true; return; }
  if (open) { closeChat(); return; }
  if (!$('admin').hidden) { leaveAdmin(); show('home'); return; }
  if (!$('requests').hidden) show('home');
});

function renderHeader() {
  const { other, viewer } = open;
  $('c-remove').hidden = open.admin;
  $('c-name').textContent = open.admin ? `${nameOf(viewer)} ↔ ${nameOf(other)}` : nameOf(other);
  $('c-status').textContent = open.admin ? 'Admin view · read-only' : statusText(other);
  $('c-avatar').replaceWith(Object.assign(avatar(other, 'avatar sm'), { id: 'c-avatar' }));
}

function renderMessages({ keepPosition = false } = {}) {
  if (!open) return;
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const oldTop = box.scrollTop;
  const fromBottom = box.scrollHeight - box.scrollTop; // to keep your place when older messages appear above
  const chatDoc = open.admin ? adminChats[open.id] : chats[open.id];
  const theyReadAt = ms(chatDoc?.lastRead?.[open.other]);
  box.innerHTML = '';
  if (!open.msgs.length) box.append(el('div', 'no-msgs', open.admin ? 'No messages' : 'Say hi 👋'));
  else if (open.loadingOlder) box.append(el('div', 'older', 'Loading older messages…'));
  else if (!open.hasMore) box.append(el('div', 'older', 'Start of conversation'));
  else box.append(el('div', 'older', 'Scroll up for older messages'));
  let lastDay = '';
  for (const m of open.msgs) {
    const t = ms(m.createdAt);
    const day = dayLabel(t);
    if (day !== lastDay) { box.append(el('div', 'day', day)); lastDay = day; }
    const mine = m.from === open.viewer;
    const b = el('div', 'msg ' + (mine ? 'mine' : 'theirs'));
    if (open.admin) b.append(el('div', 'who', nameOf(m.from)));
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
  if (keepPosition) box.scrollTop = box.scrollHeight - fromBottom;
  else if (nearBottom || open.justSent) box.scrollTop = box.scrollHeight;
  else box.scrollTop = oldTop;
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
