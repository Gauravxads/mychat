import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, doc, setDoc, updateDoc, collection, query, where,
  orderBy, limitToLast, endBefore, getDoc, getDocs, onSnapshot, addDoc, serverTimestamp, increment,
  deleteDoc, deleteField, writeBatch,
} from 'firebase/firestore';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { firebaseConfig } from './firebase-config.js';

// ---------- Native helpers ----------
// Each GitHub build has a number (baked in at build time). On launch the app asks GitHub
// for the latest release; if it is newer, it offers to download and install it.
const REPO = 'Gauravxads/mychat';
const APK_URL = `https://github.com/${REPO}/releases/latest/download/MyChat.apk`;
const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 0;
const NATIVE = Capacitor.isNativePlatform();
const Updater = registerPlugin('Updater');
const Media = registerPlugin('Media'); // saveImage / shareImage / shareText (native/MediaPlugin.java)

const $ = (id) => document.getElementById(id);

// ---------- State ----------
let auth, db;
let me = null;          // my uid
let users = {};         // uid -> {name, email, code, photo, lastSeen} — me + my contacts
let adminUsers = {};    // every profile, loaded only while an admin has the Admin screen open
let contacts = new Set(); // uids of approved contacts
let incoming = [];      // invites sent to me
let outgoing = [];      // invites I sent
let profileSubs = new Map(); // uid -> unsubscribe, live profile of each contact
let chats = {};         // chatId -> {members, lastMessage, updatedAt, unread, lastRead, typing}
let open = null;        // the open conversation (see openChat)
let unsubs = [];
let heartbeat = null;

const chatIdFor = (a, b) => [a, b].sort().join('_');
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : 0);
const profileOf = (uid) => users[uid] || adminUsers[uid] || {};
const nameOf = (uid) => profileOf(uid).name || 'Unknown';

// ---------- Small UI helpers ----------
const SCREENS = ['auth', 'home', 'requests', 'admin', 'chat', 'profile'];
function show(screen) {
  for (const s of SCREENS) $(s).hidden = s !== screen;
}
const visible = (id) => !$(id).hidden;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function askConfirm(title, text, okLabel) {
  return new Promise((res) => {
    const box = $('confirm'), yes = $('confirm-yes'), no = $('confirm-no');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    yes.textContent = okLabel;
    const done = (v) => { box.hidden = true; yes.onclick = no.onclick = null; res(v); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    box.hidden = false;
  });
}
let toastTimer;
function hideToast() { clearTimeout(toastTimer); $('toast').hidden = true; }
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}
const COLORS = ['#C2652A', '#7B4FB8', '#1F7A9C', '#B83B6B', '#3C7A3A', '#9C6B1F', '#4A5BB5', '#0E7C66'];
const isOnline = (uid) => Date.now() - ms(profileOf(uid).lastSeen) < 90_000;
function avatar(uid, cls = 'avatar', name = nameOf(uid)) {
  const a = el('div', cls);
  const photo = profileOf(uid).photo;
  if (photo) {
    const img = el('img', 'av-img');
    img.src = photo;
    img.alt = '';
    a.append(img);
  } else {
    a.textContent = name === 'Unknown' ? '?' : name.trim()[0]?.toUpperCase() || '?';
  }
  let h = 0;
  for (const c of uid || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  a.style.background = COLORS[h % COLORS.length];
  if (uid !== me && isOnline(uid)) a.classList.add('online');
  return a;
}
function setAvatar(id, uid, cls = 'avatar') {
  $(id).replaceWith(Object.assign(avatar(uid, cls), { id }));
}

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
  const t = ms(profileOf(uid).lastSeen);
  if (!t) return '';
  const label = dayLabel(t);
  return `last seen ${label === 'Today' ? 'today' : label === 'Yesterday' ? 'yesterday' : label} at ${clock(t)}`;
}
// The other person is typing if they wrote a typing time in the last 6 s.
const isTyping = (chat, uid) => Date.now() - ms(chat?.typing?.[uid]) < 6000;

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast(text);
  }
}
async function shareText(text, title) {
  if (NATIVE) {
    try { await Media.shareText({ text, title }); return; } catch (err) { console.warn(err); }
  }
  copyText(text, 'Copied. Paste it in any app to share.');
}

// ---------- Login / sign up ----------
let signupMode = false;
$('f-toggle').onclick = () => setSignupMode(!signupMode);
function setSignupMode(on) {
  signupMode = on;
  $('name-field').hidden = !signupMode;
  $('f-forgot').hidden = signupMode;
  $('auth-sub').textContent = signupMode
    ? "Create your account. You'll get your own 6-character ID to share with friends."
    : 'Private chat for your circle. Log in to see your chats.';
  $('f-submit').textContent = signupMode ? 'Create account' : 'Log in';
  $('f-toggle').textContent = signupMode ? 'Already have an account? Log in' : 'New here? Create an account';
  $('f-error').textContent = '';
  $('f-error').classList.remove('info');
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Wrong email or password. Check and try again.',
  'auth/user-not-found': 'Wrong email or password. Check and try again.',
  'auth/wrong-password': 'Wrong email or password. Check and try again.',
  'auth/invalid-email': "That email doesn't look right. Check and try again.",
  'auth/missing-email': 'Enter your email.',
  'auth/missing-password': 'Enter your password.',
  'auth/email-already-in-use': 'This email already has an account. Try logging in.',
  'auth/weak-password': 'Password is too short — use at least 6 characters.',
  'auth/network-request-failed': 'No internet. Check your connection and try again.',
  'auth/too-many-requests': 'Too many tries. Please wait a minute and try again.',
  'auth/operation-not-allowed': 'Email login is not enabled in Firebase (Authentication → Sign-in method).',
  'auth/configuration-not-found': 'Authentication is not enabled in Firebase yet.',
};
function authError(msg, info = false) {
  $('f-error').textContent = msg;
  $('f-error').classList.toggle('info', info);
}

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!auth) return;
  const email = $('f-email').value.trim();
  const pass = $('f-pass').value;
  const name = $('f-name').value.trim();
  authError('');
  if (signupMode && !name) return authError('Enter your name.');
  $('f-submit').disabled = true;
  $('f-submit').classList.add('loading');
  try {
    if (signupMode) {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await setDoc(doc(db, 'users', cred.user.uid), { name, email, lastSeen: serverTimestamp() }, { merge: true });
      // The unique ID is created by ensureCode() once the profile loads.
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    authError(AUTH_ERRORS[err.code] || err.message);
  } finally {
    $('f-submit').disabled = false;
    $('f-submit').classList.remove('loading');
  }
};

$('f-forgot').onclick = async () => {
  const email = $('f-email').value.trim();
  if (!email) { authError('Type your email above, then tap Forgot password.'); $('f-email').focus(); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    authError(`If ${email} has an account, a reset link is on its way. Check your inbox and spam folder.`, true);
  } catch (err) {
    authError(AUTH_ERRORS[err.code] || err.message);
  }
};

// ---------- App start / stop ----------
function onError(err) {
  console.error(err);
  if (err.code === 'permission-denied') toast("That didn't go through. You may not be contacts any more.");
  else if (err.code === 'unavailable') toast("You're offline. Messages will send when you're back online.");
  else toast(`Something went wrong: ${err.message}`);
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

  // My own profile (name, photo, unique ID)
  unsubs.push(onSnapshot(doc(db, 'users', me), (d) => {
    users[me] = d.data({ serverTimestamps: 'estimate' }) || {};
    setAvatar('me-avatar', me);
    if (profileFor === me) renderProfile();
    if (d.exists() && !users[me].code) ensureCode();
  }, onError));

  // Approved contacts: users/<me>/contacts/<uid>
  unsubs.push(onSnapshot(collection(db, 'users', me, 'contacts'), (snap) => {
    const chatWith = open && !open.admin ? open.other : null;
    const chatName = chatWith ? nameOf(chatWith) : ''; // read the name before the profile is dropped
    contacts = new Set(snap.docs.map((d) => d.id));
    if (profileFor && profileFor !== me && !contacts.has(profileFor) && !open?.admin) closeProfile(true);
    if (chatWith && !contacts.has(chatWith)) {
      if (removedByMe !== chatWith) toast(`${chatName} removed you from their contacts.`);
      closeChat();
    }
    removedByMe = null;
    syncProfiles();
    renderList();
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
    if (open && !open.admin) {
      if ((chats[open.id]?.unread?.[me] || 0) > 0) markRead();
      renderHeader();   // typing…
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
  closeProfile(true);
  profileSubs.forEach((u) => u());
  profileSubs = new Map();
  for (const id of ['admin-btn', 'add-modal', 'confirm', 'msg-menu', 'photo-preview', 'viewer']) $(id).hidden = true;
  me = null; users = {}; chats = {}; contacts = new Set(); incoming = []; outgoing = [];
  ensuringCode = false;
  $('list').querySelectorAll('.row').forEach((r) => r.remove());
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

const inviteText = (code) => `Add me on MyChat! My ID is ${code}\n\nGet the app: ${APK_URL}`;
$('empty-share').onclick = () => {
  const code = users[me]?.code;
  if (code) shareText(inviteText(code), 'Share your MyChat ID');
  else toast('Your ID is still being created. Try again in a moment.');
};

// Live name / photo / online status for each contact
function syncProfiles() {
  for (const uid of contacts) {
    if (profileSubs.has(uid)) continue;
    profileSubs.set(uid, onSnapshot(doc(db, 'users', uid), (d) => {
      if (!contacts.has(uid)) return;
      users[uid] = d.data({ serverTimestamps: 'estimate' }) || {};
      renderList();
      if (open?.other === uid) renderHeader();
      if (profileFor === uid) renderProfile();
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
  $('add-error').classList.remove('info');
  $('add-code').classList.remove('invalid');
  $('add-modal').hidden = false;
  $('add-code').focus();
};
$('add-cancel').onclick = () => ($('add-modal').hidden = true);
$('add-modal').onclick = (e) => { if (e.target === $('add-modal')) $('add-modal').hidden = true; };
$('add-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('add-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fail = (msg, info = false) => {
    $('add-error').textContent = msg;
    $('add-error').classList.toggle('info', info);
    $('add-code').classList.toggle('invalid', !!msg && !info);
  };
  if (code.length !== 6) return fail('An ID has 6 letters or numbers.');
  if (code === users[me]?.code) return fail("That's your own ID. Ask your friend for theirs.");
  const sendBtn = $('add-send');
  sendBtn.disabled = true;
  sendBtn.classList.add('loading');
  sendBtn.textContent = 'Sending…';
  fail('');
  try {
    const c = await getDoc(doc(db, 'codes', code));
    if (!c.exists()) return fail('No one has this ID. Check the letters and try again.');
    const uid = c.data().uid;
    if (contacts.has(uid)) return fail(`${nameOf(uid)} is already in your chats.`, true);
    const theirs = incoming.find((i) => i.from === uid);
    if (theirs) { // they already asked me: just approve
      await acceptInvite(theirs);
      $('add-modal').hidden = true;
      return;
    }
    const sent = outgoing.find((i) => i.to === uid);
    if (sent) return fail(`Request already sent. Waiting for ${sent.toName || 'them'} to approve.`, true);
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
    fail(err.code === 'permission-denied' ? 'Could not send the request. Try again.' : err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.classList.remove('loading');
    sendBtn.textContent = 'Send request';
  }
};

// ---------- Requests (bell) ----------
$('bell').onclick = () => show('requests');
$('r-back').onclick = () => navBack();

async function acceptInvite(inv) {
  // One batch: add each other as contacts and remove the request.
  const b = writeBatch(db);
  b.set(doc(db, 'users', me, 'contacts', inv.from), { since: serverTimestamp() });
  b.set(doc(db, 'users', inv.from, 'contacts', me), { since: serverTimestamp() });
  b.delete(doc(db, 'invites', inv.id));
  await b.commit();
  toast(`${inv.fromName || 'Contact'} added to your chats.`);
}

function requestRow(uid, name, code, buttons) {
  const row = el('div', 'req');
  const info = el('div', 'req-info');
  info.append(el('div', 'name', name || 'Unknown'), el('span', null, `ID ${code || '—'}`));
  const actions = el('div', 'req-actions');
  actions.append(...buttons);
  row.append(avatar(uid, 'avatar', name || '?'), info, actions);
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
  $('bell-badge').textContent = n === 0 ? '' : n > 9 ? '9+' : String(n); // CSS hides it when empty
  $('bell').setAttribute('aria-label', n ? `Contact requests (${n} new)` : 'Contact requests');
  const inList = $('r-in'), outList = $('r-out');
  inList.innerHTML = '';
  outList.innerHTML = '';
  for (const inv of incoming) {
    inList.append(requestRow(inv.from, inv.fromName, inv.fromCode, [
      smallBtn('Reject', 'ghost', () => deleteDoc(doc(db, 'invites', inv.id))),
      smallBtn('Approve', 'solid', () => acceptInvite(inv)),
    ]));
  }
  for (const inv of outgoing) {
    outList.append(requestRow(inv.to, inv.toName, inv.toCode, [
      el('span', 'pending', 'Pending'),
      smallBtn('Cancel', 'ghost', () => deleteDoc(doc(db, 'invites', inv.id))),
    ]));
  }
  $('r-in-empty').hidden = incoming.length > 0;
  $('r-out-empty').hidden = outgoing.length > 0;
}

// ---------- Profile (mine or a contact's) ----------
let profileFor = null;    // uid shown on the profile screen
let removedByMe = null;   // set while I remove a contact, so I don't get a "they removed you" toast
let profileReturn = 'home';

function openProfile(uid) {
  profileFor = uid;
  profileReturn = visible('chat') ? 'chat' : 'home';
  $('p-name-form').hidden = true;
  show('profile');
  renderProfile();
}
function closeProfile(silent = false) {
  if (!profileFor) return;
  profileFor = null;
  if (!silent || visible('profile')) show(open ? 'chat' : profileReturn === 'chat' ? 'home' : profileReturn);
}
$('me-btn').onclick = () => openProfile(me);
$('c-info').onclick = () => { if (open && !open.admin) openProfile(open.other); };
$('p-back').onclick = () => navBack();

function renderProfile() {
  const uid = profileFor;
  if (!uid) return;
  const mine = uid === me;
  const p = profileOf(uid);
  $('p-title').textContent = mine ? 'My profile' : 'Contact info';
  setAvatar('p-avatar', uid);
  $('p-avatar').onclick = () => { if (p.photo) openViewer(p.photo); };
  $('p-photo-btn').hidden = !mine;
  $('p-photo-remove').hidden = !(mine && p.photo);
  $('p-status').textContent = mine ? '' : statusText(uid);
  $('p-status').classList.toggle('online', !mine && isOnline(uid));
  $('p-name').textContent = p.name || '—';
  $('p-edit-name').hidden = !mine;
  $('p-email').textContent = p.email || '—';
  $('p-code').textContent = p.code || '…';
  $('c-remove').hidden = mine;
  $('logout').hidden = !mine;
  $('p-version').textContent = mine && BUILD ? `MyChat version ${BUILD}` : '';
}

$('p-copy').onclick = () => {
  const code = profileOf(profileFor).code;
  if (code) copyText(code, `ID ${code} copied.`);
};
$('p-share').onclick = () => {
  const p = profileOf(profileFor);
  if (!p.code) return;
  shareText(profileFor === me ? inviteText(p.code) : `${p.name}'s MyChat ID: ${p.code}`, 'Share MyChat ID');
};
$('p-edit-name').onclick = () => {
  $('p-name-input').value = users[me]?.name || '';
  $('p-name-form').hidden = false;
  $('p-name-input').focus();
};
$('p-name-cancel').onclick = () => ($('p-name-form').hidden = true);
$('p-name-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('p-name-input').value.trim();
  if (!name) return toast('Name cannot be empty.');
  $('p-name-form').hidden = true;
  try {
    await setDoc(doc(db, 'users', me), { name }, { merge: true });
    toast('Name updated.');
  } catch (err) { onError(err); }
};
$('p-photo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const photo = await squarePhoto(file, 256);
    await setDoc(doc(db, 'users', me), { photo }, { merge: true });
    toast('Profile photo updated.');
  } catch (err) {
    console.error(err);
    toast('Could not use that photo. Try another one.');
  }
};
$('p-photo-remove').onclick = async () => {
  if (!(await askConfirm('Remove profile photo?', 'Your contacts will see your initial instead.', 'Remove'))) return;
  try { await setDoc(doc(db, 'users', me), { photo: deleteField() }, { merge: true }); } catch (err) { onError(err); }
};
$('logout').onclick = async () => {
  if (await askConfirm('Log out of MyChat?', 'Your chats are saved. Log in again with the same email to see them.', 'Log out')) signOut(auth);
};
$('c-remove').onclick = async () => {
  const other = profileFor;
  if (!other || other === me) return;
  const name = nameOf(other);
  if (!(await askConfirm(`Remove ${name}?`, "You'll disappear from each other's chat lists. To chat again, one of you will need to send a new request.", 'Remove'))) return;
  const b = writeBatch(db);
  b.delete(doc(db, 'users', me, 'contacts', other));
  b.delete(doc(db, 'users', other, 'contacts', me));
  removedByMe = other;
  try {
    await b.commit();
    toast(`${name} removed.`);
  } catch (err) { onError(err); }
};

// ---------- Chat list ----------
$('search').oninput = () => renderList();

function previewOf(last, uid) {
  if (!last) return 'Tap to chat';
  return (last.from === me ? 'You: ' : '') + last.text;
}

function renderList() {
  if (!me) return;
  const q = $('search').value.trim().toLowerCase();
  const others = [...contacts]
    .filter((uid) => uid !== me && nameOf(uid).toLowerCase().includes(q))
    .map((uid) => ({ uid, chat: chats[chatIdFor(me, uid)] }))
    .sort((a, b) => ms(b.chat?.updatedAt) - ms(a.chat?.updatedAt)
      || nameOf(a.uid).localeCompare(nameOf(b.uid)));

  const list = $('list');
  list.querySelectorAll('.row').forEach((r) => r.remove()); // keep #empty and #version
  $('empty').hidden = others.length > 0 || q !== '' || contacts.size > 0;
  for (const { uid, chat } of others) {
    const unread = chat?.unread?.[me] || 0;
    const row = el('div', 'row');
    row.append(avatar(uid));
    const mid = el('div', 'mid');
    const top = el('div', 'top');
    top.append(el('span', 'name', nameOf(uid)),
      el('span', 'time' + (unread ? ' unread' : ''), listTime(ms(chat?.updatedAt))));
    const bottom = el('div', 'bottom');
    if (isTyping(chat, uid)) bottom.append(el('span', 'preview typing', 'typing…'));
    else bottom.append(el('span', 'preview', previewOf(chat?.lastMessage, uid)));
    if (unread) bottom.append(el('span', 'badge', unread > 99 ? '99+' : String(unread)));
    mid.append(top, bottom);
    row.append(mid);
    row.onclick = () => openChat(uid);
    list.insertBefore(row, $('empty'));
  }
  if (q && !others.length) {
    const none = el('div', 'row no-results', `No contacts match "${$('search').value.trim()}"`);
    list.insertBefore(none, $('empty'));
  }
}

// ---------- Admin: all conversations (read-only) ----------
let adminChats = {};
let adminUnsubs = [];

$('admin-btn').onclick = () => {
  show('admin');
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
$('a-back').onclick = () => navBack();

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
    const row = el('div', 'row');
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

// ---------- Conversation ----------
// Messages load in pages: the newest PAGE live, then PAGE older ones each time you scroll to the top.
const PAGE = 50;
let chatTick = null; // refreshes "typing…" / "online" while a chat is open

function storeDoc(d) {
  open.byId.set(d.id, { id: d.id, snap: d, pending: d.metadata.hasPendingWrites, ...d.data({ serverTimestamps: 'estimate' }) });
}
function sortedMsgs() {
  return [...open.byId.values()].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
}

// Normal chat: openChat(otherUid). Admin view: openChat(uidB, { adminChatId, viewer: uidA }) — read-only.
function openChat(other, { adminChatId = null, viewer = me } = {}) {
  const id = adminChatId || chatIdFor(me, other);
  // byId keeps every message seen so far, so ones that scroll out of the live window are not lost.
  // nodes caches each message's element so re-renders don't rebuild (and reload) every photo.
  open = {
    id, other, viewer, admin: !!adminChatId, byId: new Map(), nodes: new Map(),
    msgs: [], unsub: null, hasMore: true, loadingOlder: false,
  };
  $('composer').hidden = open.admin;
  $('chat').classList.toggle('admin-view', open.admin); // CSS: indigo header, read-only bar
  setReply(null);
  $('to-bottom').hidden = true;
  show('chat');
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
  clearInterval(chatTick);
  chatTick = setInterval(() => { if (open) renderHeader(); }, 3000);
  if (!open.admin && chats[id]) markRead();
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
  const box = $('msgs');
  if (box.scrollTop < 150) loadOlder();
  $('to-bottom').hidden = box.scrollHeight - box.scrollTop - box.clientHeight < 400;
});
$('to-bottom').onclick = () => {
  const box = $('msgs');
  box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
};

function closeChat() {
  if (!open) return;
  const wasAdmin = open.admin;
  open.unsub?.();
  open = null;
  clearInterval(chatTick);
  setReply(null);
  $('text').value = '';
  $('text').style.height = '';
  $('composer').hidden = false;
  $('chat').classList.remove('admin-view');
  if (me) show(wasAdmin ? 'admin' : 'home');
}
$('back').onclick = () => navBack();

function renderHeader() {
  if (!open) return;
  const { other, viewer } = open;
  $('c-name').textContent = open.admin ? `${nameOf(viewer)} ↔ ${nameOf(other)}` : nameOf(other);
  const typing = !open.admin && isTyping(chats[open.id], other);
  $('c-status').textContent = open.admin ? 'Admin view · read-only' : typing ? 'typing…' : statusText(other);
  $('c-status').classList.toggle('online', !open.admin && (typing || isOnline(other)));
  setAvatar('c-avatar', other);
}

// Turn URLs in text into tappable links (they open in the phone's browser).
const URL_RE = /\b(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/gi;
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const a = el('a', null, m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.onclick = (e) => e.stopPropagation();
    frag.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const snippet = (m) => (m.deleted ? 'Deleted message' : m.text ? m.text.slice(0, 100) : m.image ? '📷 Photo' : '');

function msgNode(m, theyReadAt) {
  const t = ms(m.createdAt);
  const mine = m.from === open.viewer;
  const read = mine && !m.pending && theyReadAt && t <= theyReadAt;
  const key = [m.text, m.image ? m.image.length : 0, m.pending, read, m.deleted, m.replyTo?.id, t, open.admin && nameOf(m.from)].join('|');
  const cached = open.nodes.get(m.id);
  if (cached && cached.key === key) return cached.el;

  const b = el('div', 'msg ' + (mine ? 'mine' : 'theirs'));
  b.dataset.id = m.id;
  if (open.admin) b.append(el('div', 'who', nameOf(m.from)));
  if (m.deleted) {
    b.append(el('span', 'deleted', mine && !open.admin ? '🚫 You deleted this message' : '🚫 This message was deleted'));
  } else {
    if (m.replyTo) {
      const q = el('div', 'quote');
      const who = m.replyTo.from === me && !open.admin ? 'You' : nameOf(m.replyTo.from);
      q.append(el('b', m.replyTo.from === m.from ? '' : 'q-them', who), el('span', null, m.replyTo.text || '📷 Photo'));
      q.onclick = (e) => { e.stopPropagation(); jumpTo(m.replyTo.id); };
      b.append(q);
    }
    if (m.image) {
      const img = el('img');
      img.src = m.image;
      img.alt = 'Photo';
      img.loading = 'lazy';
      img.onclick = () => openViewer(m.image);
      b.append(img);
    }
    if (m.text) b.append(linkify(m.text));
  }
  const meta = el('span', 'meta', clock(t));
  if (mine && !m.deleted) {
    meta.append(el('span', 'tick' + (read ? ' read' : ''), m.pending ? '🕓' : read ? '✓✓' : '✓'));
  }
  b.append(meta);
  attachGestures(b, m.id);
  open.nodes.set(m.id, { key, el: b });
  return b;
}

function renderMessages({ keepPosition = false } = {}) {
  if (!open) return;
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const oldTop = box.scrollTop;
  const fromBottom = box.scrollHeight - box.scrollTop; // keeps your place when older messages appear above
  const chatDoc = open.admin ? adminChats[open.id] : chats[open.id];
  const theyReadAt = ms(chatDoc?.lastRead?.[open.other]);
  const nodes = [];
  if (!open.msgs.length) nodes.push(el('div', 'no-msgs', open.admin ? 'No messages' : 'Say hi 👋'));
  else if (open.loadingOlder) nodes.push(el('div', 'older', 'Loading older messages…'));
  else if (!open.hasMore) nodes.push(el('div', 'older', 'Start of conversation'));
  else nodes.push(el('div', 'older', 'Scroll up for older messages'));
  let lastDay = '';
  for (const m of open.msgs) {
    const day = dayLabel(ms(m.createdAt));
    if (day !== lastDay) { nodes.push(el('div', 'day', day)); lastDay = day; }
    nodes.push(msgNode(m, theyReadAt));
  }
  box.replaceChildren(...nodes);
  if (keepPosition) box.scrollTop = box.scrollHeight - fromBottom;
  else if (nearBottom || open.justSent) box.scrollTop = box.scrollHeight;
  else box.scrollTop = oldTop;
  open.justSent = false;
}

function jumpTo(id) {
  const node = open?.nodes.get(id)?.el;
  if (!node || !node.isConnected) return toast('That message is further up. Scroll up to load it.');
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
}

// Long-press a message for the menu; swipe it right to reply.
function attachGestures(node, id) {
  let timer = null, x0 = 0, y0 = 0, dx = 0, swiping = false;
  const cancel = () => { clearTimeout(timer); timer = null; node.classList.remove('pressed'); };
  node.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dx = 0; swiping = false;
    node.classList.add('pressed');
    timer = setTimeout(() => { timer = null; node.classList.remove('pressed'); openMsgMenu(id); }, 450);
  }, { passive: true });
  node.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    dx = t.clientX - x0;
    const dy = Math.abs(t.clientY - y0);
    if (Math.abs(dx) > 8 || dy > 8) cancel();
    if (!open?.admin && dx > 10 && dy < 30) {
      swiping = true;
      node.style.transform = `translateX(${Math.min(dx, 80)}px)`;
    }
  }, { passive: true });
  node.addEventListener('touchend', () => {
    cancel();
    if (swiping) {
      node.style.transform = '';
      if (dx > 60) { const m = open?.byId.get(id); if (m && !m.deleted) setReply(m); }
    }
  });
  node.addEventListener('touchcancel', () => { cancel(); node.style.transform = ''; });
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); if ($('msg-menu').hidden) openMsgMenu(id); });
}

// ---------- Message menu ----------
let menuMsg = null;
function openMsgMenu(id) {
  const m = open?.byId.get(id);
  if (!m) return;
  menuMsg = m;
  const mine = m.from === me && !open.admin;
  $('m-reply').hidden = open.admin || m.deleted;
  $('m-copy').hidden = m.deleted || !m.text;
  $('m-save').hidden = m.deleted || !m.image;
  $('m-share').hidden = m.deleted || !m.image;
  $('m-delete').hidden = !mine || m.deleted;
  hideToast();
  $('msg-menu').hidden = false;
}
function closeMsgMenu() { $('msg-menu').hidden = true; menuMsg = null; }
$('m-cancel').onclick = closeMsgMenu;
$('msg-menu').onclick = (e) => { if (e.target === $('msg-menu')) closeMsgMenu(); };
$('m-reply').onclick = () => { const m = menuMsg; closeMsgMenu(); setReply(m); };
$('m-copy').onclick = () => { const m = menuMsg; closeMsgMenu(); copyText(m.text, 'Message copied.'); };
$('m-save').onclick = () => { const m = menuMsg; closeMsgMenu(); savePhoto(m.image); };
$('m-share').onclick = () => { const m = menuMsg; closeMsgMenu(); sharePhoto(m.image); };
$('m-delete').onclick = async () => {
  const m = menuMsg;
  closeMsgMenu();
  if (!(await askConfirm('Delete for everyone?', 'This message will be removed for both of you.', 'Delete'))) return;
  const chatId = open.id;
  try {
    await updateDoc(doc(db, 'chats', chatId, 'messages', m.id), {
      deleted: true, text: deleteField(), image: deleteField(), replyTo: deleteField(),
    });
    // If it was the newest message, fix the preview in the chat list too.
    const newest = open?.msgs[open.msgs.length - 1];
    if (newest?.id === m.id) {
      await setDoc(doc(db, 'chats', chatId), {
        members: chatId.split('_'), lastMessage: { text: '🚫 Message deleted', from: me },
      }, { merge: true });
    }
  } catch (err) { onError(err); }
};

// ---------- Reply ----------
let replyTo = null;
function setReply(m) {
  replyTo = m ? { id: m.id, from: m.from, text: m.text ? m.text.slice(0, 100) : '', image: !!m.image } : null;
  $('reply-bar').hidden = !replyTo;
  if (!replyTo) return;
  $('reply-name').textContent = m.from === me ? 'You' : nameOf(m.from);
  $('reply-text').textContent = snippet(m);
  $('text').focus();
}
$('reply-cancel').onclick = () => setReply(null);

function markRead() {
  if (!open || open.admin || document.visibilityState !== 'visible') return;
  setDoc(doc(db, 'chats', open.id), {
    members: [me, open.other].sort(),
    unread: { [me]: 0 },
    lastRead: { [me]: serverTimestamp() },
  }, { merge: true }).catch(onError);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { ping(); if (open && chats[open.id]) markRead(); }
});

function send(message, previewText) {
  if (!open || open.admin) return;
  const { id, other } = open;
  open.justSent = true;
  if (replyTo) message.replyTo = replyTo;
  setReply(null);
  lastTypingSent = 0;
  // Not awaited: Firestore queues writes, so sending works instantly and offline.
  addDoc(collection(db, 'chats', id, 'messages'), { ...message, from: me, createdAt: serverTimestamp() }).catch(onError);
  setDoc(doc(db, 'chats', id), {
    members: [me, other].sort(),
    updatedAt: serverTimestamp(),
    lastMessage: { text: previewText.slice(0, 100), from: me },
    unread: { [other]: increment(1) },
    lastRead: { [me]: serverTimestamp() },
    typing: { [me]: 0 },
  }, { merge: true }).catch(onError);
}

// "typing…": at most one small write every 4 s while typing.
let lastTypingSent = 0;
function sendTyping() {
  if (!open || open.admin || Date.now() - lastTypingSent < 4000) return;
  lastTypingSent = Date.now();
  setDoc(doc(db, 'chats', open.id), {
    members: [me, open.other].sort(), typing: { [me]: serverTimestamp() },
  }, { merge: true }).catch(() => {});
}

const textBox = $('text');
textBox.oninput = () => {
  textBox.style.height = 'auto';
  textBox.style.height = Math.min(textBox.scrollHeight, 120) + 'px';
  if (textBox.value.trim()) sendTyping();
};
$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = textBox.value.trim();
  if (!text) return;
  send({ text }, text);
  textBox.value = '';
  textBox.style.height = '';
  textBox.focus();
};

// ---------- Photos ----------
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
// Profile photos: centre square, small.
async function squarePhoto(file, size) {
  const img = await createImageBitmap(file);
  const s = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.82);
}

let pendingPhoto = null;
$('photo').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !open) return;
  try {
    pendingPhoto = await compressImage(file);
    $('pp-img').src = pendingPhoto;
    $('pp-caption').value = textBox.value.trim(); // carry over anything already typed
    hideToast();
    $('photo-preview').hidden = false;
  } catch (err) {
    toast('Could not read that photo.');
    console.error(err);
  }
};
function closePhotoPreview() {
  $('photo-preview').hidden = true;
  $('pp-img').removeAttribute('src');
  pendingPhoto = null;
}
$('pp-cancel').onclick = closePhotoPreview;
$('pp-form').onsubmit = (e) => {
  e.preventDefault();
  if (!pendingPhoto) return;
  const caption = $('pp-caption').value.trim();
  const msg = { image: pendingPhoto };
  if (caption) msg.text = caption;
  send(msg, caption ? `📷 ${caption}` : '📷 Photo');
  if (caption && textBox.value.trim() === caption) { textBox.value = ''; textBox.style.height = ''; }
  closePhotoPreview();
};

async function savePhoto(dataUrl) {
  if (NATIVE) {
    try {
      await Media.saveImage({ data: dataUrl, fileName: `MyChat_${Date.now()}.jpg` });
      toast('Saved to your gallery (Pictures › MyChat).');
      return;
    } catch (err) {
      // Android 9 and older can't save without a storage permission: offer the share sheet instead.
      if (String(err.message || err).includes('unsupported')) {
        toast('Choose "Save" or your gallery app to keep the photo.');
        return sharePhoto(dataUrl);
      }
      return toast(`Could not save the photo: ${err.message || err}`);
    }
  }
  const a = el('a');
  a.href = dataUrl;
  a.download = `MyChat_${Date.now()}.jpg`;
  a.click();
}
async function sharePhoto(dataUrl) {
  if (NATIVE) {
    try { await Media.shareImage({ data: dataUrl }); } catch (err) { toast(`Could not share: ${err.message || err}`); }
    return;
  }
  savePhoto(dataUrl);
}

// ---------- Photo viewer ----------
let viewerSrc = null;
function openViewer(src) {
  viewerSrc = src;
  $('viewer-img').src = src;
  hideToast();
  $('viewer').hidden = false;
}
function closeViewer() { $('viewer').hidden = true; viewerSrc = null; }
$('v-close').onclick = (e) => { e.stopPropagation(); closeViewer(); };
$('v-save').onclick = (e) => { e.stopPropagation(); if (viewerSrc) savePhoto(viewerSrc); };
$('v-share').onclick = (e) => { e.stopPropagation(); if (viewerSrc) sharePhoto(viewerSrc); };
$('viewer').onclick = (e) => { if (e.target === $('viewer')) closeViewer(); };

// ---------- Back button ----------
// Android's back button (and Esc on a computer) closes the top-most thing, one step at a time.
// On the chat list it puts the app in the background instead of closing it.
function navBack() {
  if (!$('confirm').hidden) { $('confirm-no').click(); return true; }
  if (!$('viewer').hidden) { closeViewer(); return true; }
  if (!$('msg-menu').hidden) { closeMsgMenu(); return true; }
  if (!$('photo-preview').hidden) { closePhotoPreview(); return true; }
  if (!$('add-modal').hidden) { $('add-modal').hidden = true; return true; }
  if (!$('update').hidden) { if (!$('u-later').hidden) $('update').hidden = true; return true; }
  if (visible('profile')) {
    if (!$('p-name-form').hidden) { $('p-name-form').hidden = true; return true; }
    closeProfile(); return true;
  }
  if (open) {
    if (replyTo) { setReply(null); return true; }
    closeChat(); return true;
  }
  if (visible('requests')) { show('home'); return true; }
  if (visible('admin')) { leaveAdmin(); show('home'); return true; }
  if (visible('home') && $('search').value) { $('search').value = ''; renderList(); return true; }
  return false;
}
App.addListener('backButton', () => { if (!navBack()) App.minimizeApp(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') navBack(); });

// ---------- Update prompt ----------
async function checkForUpdate() {
  if (!NATIVE || !BUILD) return;
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

// One helper per step: title, text (fixed strings only), and which buttons show.
function updateStep(title, html, { progress = false, yes = null, later = true } = {}) {
  $('u-title').textContent = title;
  $('u-text').innerHTML = html;
  $('u-progress').hidden = !progress;
  $('u-later').hidden = !later;
  $('u-yes').hidden = !yes;
  if (yes) { $('u-yes').textContent = yes.label; $('u-yes').onclick = yes.fn; }
  $('update').hidden = false;
}
$('u-later').onclick = () => ($('update').hidden = true);

function showUpdate(latest, url, size) {
  const mb = size ? ` (${(size / 1048576).toFixed(1)} MB)` : '';
  updateStep('Update available',
    `A new version of MyChat is ready${mb}. Your chats stay safe — nothing is deleted.`,
    { yes: { label: 'Update', fn: () => downloadUpdate(url) } });
}

async function downloadUpdate(url) {
  $('u-fill').style.width = '0%';
  $('u-pct').textContent = '0%';
  updateStep('Downloading update…', 'Keep MyChat open. This takes under a minute on mobile data.',
    { progress: true, later: false });
  const listener = await Updater.addListener('progress', ({ loaded, total }) => {
    const pct = total > 0 ? Math.floor((loaded / total) * 100) : null;
    $('u-fill').style.width = (pct ?? 50) + '%';
    $('u-pct').textContent = pct != null ? `${pct}%` : `${(loaded / 1048576).toFixed(1)} MB`;
    if (pct != null) $('u-bar').setAttribute('aria-valuenow', String(pct));
  });
  try {
    await Updater.download({ url });
    $('u-fill').style.width = '100%';
    $('u-pct').textContent = '100%';
    await installUpdate();
  } catch (err) {
    console.warn('Update download failed', err);
    updateStep("Download didn't finish", 'Check your internet connection and try again. Your chats are not affected.',
      { yes: { label: 'Retry', fn: () => downloadUpdate(url) } });
  } finally {
    listener.remove();
  }
}

async function installUpdate() {
  const { needsPermission } = await Updater.install();
  const again = { label: 'Install', fn: () => installUpdate() };
  if (needsPermission) {
    updateStep('One quick setting',
      'Android needs your OK to install updates from MyChat. Turn on <b>Allow from this source</b>, then come back and tap Install.',
      { yes: again });
  } else {
    updateStep('Almost done',
      "Tap <b>Update</b> in the Android prompt to finish. Didn't see it? Tap Install to try again.",
      { yes: again });
  }
}

// ---------- Boot ----------
$('version').textContent = BUILD ? `Version ${BUILD}` : '';
checkForUpdate();
if (firebaseConfig.apiKey.startsWith('PASTE')) {
  show('auth');
  $('setup-msg').textContent = 'Firebase is not set up yet. Paste your config into src/firebase-config.js and rebuild.';
  $('f-submit').disabled = true;
} else {
  const app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  onAuthStateChanged(auth, (user) => (user ? start(user) : stop()));
}
