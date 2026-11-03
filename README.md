# MyChat — private chat app (Android APK)

People who install the app can create an account and chat 1-to-1: text, photos, read ticks (✓ sent, blue ✓✓ read), online / last seen, unread counts.

- **Firebase** (free) stores accounts and messages and syncs them live.
- **GitHub** (free) builds the APK automatically and gives you a download link.

You do not need Android Studio or Play Store.

---

## Step 1 — Firebase (about 5 minutes)

1. Go to <https://console.firebase.google.com> → **Create a project** → name it `mychat` → turn **off** Google Analytics → Create.
2. Left menu **Build → Authentication** → **Get started** → **Email/Password** → turn on the first switch → **Save**.
3. Left menu **Build → Firestore Database** → **Create database** → location **asia-south1 (Mumbai)** → **Start in production mode** → Create.
4. In Firestore, open the **Rules** tab → delete everything → paste the full content of the `firestore.rules` file → **Publish**.
5. Click the ⚙️ gear (top left) → **Project settings** → scroll to **Your apps** → click the **`</>`** (Web) icon → nickname `mychat` → **Register app**.
6. You will see a `firebaseConfig = { ... }` block. Keep this page open; you need these values in Step 2.

## Step 2 — GitHub (about 5 minutes)

1. Create an account at <https://github.com> if you don't have one.
2. Click **+** (top right) → **New repository** → name `mychat` → choose **Public** (so friends can download without a GitHub login) → **Create repository**.
3. Click **uploading an existing file** → drag in **everything inside** the `chatapp` folder (including the `.github` folder) → **Commit changes**.
   - On a Mac the `.github` folder is hidden. If it didn't upload: **Add file → Create new file**, type the name `.github/workflows/build-apk.yml`, paste that file's content, and commit.
4. Open `src/firebase-config.js` on GitHub → click the ✏️ pencil → replace the `PASTE_...` values with your values from Step 1.6 → **Commit changes**.
5. Open the **Actions** tab. The "Build APK" job starts by itself and takes about 5 minutes. A green tick means it is done.

## Step 3 — Share the link

One link for Android **and** iPhone (published by `.github/workflows/pages.yml`; one-time setup: **Settings → Pages → Source: GitHub Actions**):

```
https://gauravxads.github.io/mychat/
```

- **Android:** the APK starts downloading by itself.
- **iPhone:** iPhones can't install APKs, so it opens MyChat in Safari. Tap **Share → Add to Home Screen** and it opens from its own icon like an app. iPhone and Android users chat with each other normally.

Direct APK link (Android only): `https://github.com/Gauravxads/mychat/releases/latest/download/MyChat.apk`

To install on Android, open the link → the APK downloads → tap it. If Android asks, allow **"Install unknown apps"** for Chrome. If Play Protect warns about an unknown app, tap **More details → Install anyway**. Then open the app → **Create an account**.

Everyone who signs up appears in everyone else's contact list.

## Updating the app

Edit any file on GitHub and commit. A new APK is built automatically (about 5 minutes).

**People don't need to reinstall.** When they open MyChat, it checks for a newer build and asks **"Update available — Update / Later"**. Tapping Update downloads it with a progress bar and opens Android's installer. The first time, Android asks them to allow "Install unknown apps" for MyChat. Chats are kept.

The download link always gives the newest version too. Change the app's name in `capacitor.config.json` (`appName`).

## Contacts, requests and admin

- **Unique ID:** every account gets a 6-character ID (e.g. `K7Q2MX`), shown at the top of the chat list with a Copy button.
- **Add a contact:** tap **＋**, enter their ID → they get a request under the **🔔 bell**. They tap **Approve** or **Reject**. Only approved contacts appear in the chat list and can message each other.
- **Remove a contact:** open the chat → **Remove**. It disappears from both lists; to chat again, send a new request.
- **Admin:** an account marked as admin (a document `admins/<user UID>` in Firestore, added from the Firebase console) sees an **Admin** button that lists every conversation, read-only.

To make someone admin: Firebase console → Authentication → copy their **User UID** → Firestore → Start collection `admins` → Document ID = that UID → add any field (e.g. `role` = `admin`) → Save.

## Good to know

- **Cost:** Firebase's free plan allows about 50,000 reads and 20,000 writes per day. That is plenty for family, friends or a small team.
- **Notifications:** there are no notifications while the app is fully closed. You see new messages when you open it. Notifications need Firebase's paid "Blaze" plan and can be added later.
- **Privacy:** messages are protected by login and the security rules, so only the two people in a chat can read it. They are **not** end-to-end encrypted, and the Firebase project owner (you) could see them in the console.
- **Public repo:** the Firebase config in the code is safe to be public, because the rules protect the data. The `debug.keystore.b64` signing key is also public. That is fine for private use, but don't use this setup for a store release.
- **Photos** are compressed and stored inside the message, so the free plan is enough without Firebase Storage.

## Files

| File | What it is |
| --- | --- |
| `www/index.html`, `www/style.css` | Screens and look |
| `src/app.js` | All app logic |
| `src/firebase-config.js` | Your Firebase keys (you edit this) |
| `firestore.rules` | Security rules (paste into Firebase) |
| `.github/workflows/build-apk.yml` | Builds the APK on GitHub |
| `capacitor.config.json` | App name and ID |
| `native/*.java` | Android code for the in-app updater |
| `debug.keystore.b64` | Signing key (base64 text), so updates install over the old app |
