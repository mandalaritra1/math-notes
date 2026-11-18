# Math Notes

A personal note-taking web app: Markdown with live LaTeX, pen ink drawn directly
over the text, offline-first storage, and sync to your own Google Drive.
There is no backend server. It runs on GitHub Pages and installs as an app on Android.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

## How it is put together

| File | What it does |
| --- | --- |
| `src/editor.ts` | CodeMirror 6 editor with Markdown highlighting |
| `src/math.ts` | Finds `$…$` / `$$…$$` and renders them with KaTeX; the formula under the cursor shows its source |
| `src/ink.ts` | Pen layer over the text. Each stroke is anchored to the character under its centre, so it moves with the text when you edit or reflow. Handles pen, mouse, eraser, palm rejection and undo |
| `src/db.ts` | IndexedDB storage (works offline) |
| `src/sync.ts` | Google sign-in and Drive sync (browser only) |
| `src/format.ts` | The file formats on Drive |
| `src/main.ts` | The app shell: notes list, search, folders, tags, sync button |

### Input rules

- **Pen (S Pen):** always draws, with pressure. Hold the side button to erase. Android's
  handwriting-to-text is switched off over the note (`touch-action: none`), so the pen
  never gets turned into typing.
- **Finger:** scrolls and places the cursor. It never draws. While the pen is touching
  or hovering, finger and palm touches are ignored.
- **Mouse:** edits text. Turn on the arrow button in the pen palette to draw with it
  (the button is hidden on touch devices).
- The floating pen palette also has **Undo/Redo**, which cover both text and ink.
- **Ctrl/Cmd+Z** undoes ink as well as text. Deleting text also deletes the ink drawn on it.

The small readout at the end of the pen palette (`pen p=0.43 btn=1 cancel=0`) shows the last pointer type,
its pressure, which buttons were held (2 = S Pen side button), and how many strokes the
browser cancelled. Use it to check the S Pen
on the tablet: you should see `pen` and a pressure that changes as you press.

### Files on Google Drive

```
My Drive/
  Math Notes/
    Quantum notes.md         YAML frontmatter (id, folder, tags, dates) + Markdown
    ink/
      <note id>.json         the pen strokes for that note
```

The app only has the `drive.file` permission. It can see the files it created and
nothing else in your Drive.

## Setting up Google Drive sync (one-time, free)

You create your own OAuth "client ID". It is a public identifier, not a secret,
and it tells Google which web addresses may ask you for Drive access.

1. **Create a project.** Open <https://console.cloud.google.com/>. Click the project picker
   at the top, then **New project**. Name it `math-notes` and click **Create**, then select it.
2. **Enable the Drive API.** Go to ☰ menu → **APIs & Services → Library**, search
   for **Google Drive API**, open it and click **Enable**.
3. **Set up the consent screen.** Go to ☰ menu → **Google Auth Platform** and click **Get started**.
   - App name: `Math Notes`. Support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail. Agree to the policy and click **Create**.
4. **Allow yourself to sign in.** Open **Audience → Test users → Add users**, add your
   Gmail address and save. While the app is in "Testing" mode, only listed test users can
   sign in, which is what you want for a personal app.
   In Testing mode Google expires the grant after 7 days, so about once a week the
   pop-up asks you to allow access again. To stop that, click **Publish app** on the
   Audience page. `drive.file` is a non-sensitive scope, so this needs no Google review.
   You will still see the "unverified app" notice.
5. **Declare the scope (optional but tidy).** Open **Data Access → Add or remove scopes**,
   tick `.../auth/drive.file`, click **Update**, then **Save**.
6. **Create the client ID.** Open **Clients → Create client**:
   - Application type: **Web application**. Name: `Math Notes web`.
   - **Authorized JavaScript origins** (scheme and host only, no path):
     - `http://localhost:5173`
     - `http://localhost`
     - `https://<your-github-username>.github.io`
   - Leave *Authorized redirect URIs* empty and click **Create**.
   - Copy the **Client ID** (`1234…-abc….apps.googleusercontent.com`).
7. **Connect the app.** In Math Notes, open **Drive settings** at the bottom of the
   notes list, paste the client ID, then press **⟳ Sync with Drive**.
   - A Google pop-up asks you to choose your account.
   - You will see *"Google hasn't verified this app"*. That is expected for your own
     app: click **Continue**, then allow access.

After that:

- Edits sync automatically a few seconds after you stop typing, and every 3 minutes.
- Google's access token lasts about an hour. When it expires, press **Sync** again;
  the pop-up usually closes by itself.
- If you edit the same note on two devices before syncing, this device's version wins.
  The other version is kept as a note titled "… (conflict copy)".
- Google only accepts sign-in from `localhost` or `https://` addresses. On the tablet,
  sign in from the GitHub Pages URL, not from your Mac's LAN address.

To skip pasting the ID on each device, put it in a file named `.env.local`
(git-ignored), which bakes it into local builds:

```
VITE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
```

## Trying it on the Android tablet before deploying

Run `npm run dev` on the Mac. The `--host` flag is already set, so Vite prints a
`Network:` address such as `http://192.168.1.20:5173`. Open that address in Chrome on the
tablet, on the same Wi-Fi, to try the pen and math. Drive sign-in and offline install
only work from the deployed https site.

## Deploy to GitHub Pages and install on Android

The workflow `.github/workflows/deploy.yml` builds the app and publishes it on every push to `main`.

1. Create a **public** GitHub repository named `math-notes`. Free GitHub Pages needs a
   public repo. If you use another name, change `PAGES_BASE` in `vite.config.ts`.
2. Push this repository to it.
3. In the repo, open **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**. Re-run the workflow from the **Actions** tab if the first run
   happened before you changed this.
4. The app is now at `https://<your-username>.github.io/math-notes/`. Make sure
   `https://<your-username>.github.io` is in the OAuth client's *Authorized JavaScript
   origins* (step 6 of the Drive setup).
5. Optional: under **Settings → Secrets and variables → Actions → Variables**, add
   `GOOGLE_CLIENT_ID` so you never have to paste it on a new device.

**Install on the tablet:** open the URL in Chrome, then use ⋮ → **Install app**
(or **Add to Home screen**). It opens full-screen and works offline. Your notes are
stored on the device, and sync runs whenever you are online and signed in. Updates
install silently the next time the app starts.
