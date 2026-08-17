# Airlock Phase 2 Implementation Plan, part 4: accept, decline, and the Windows send flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part3.md`. Numbering is unbroken and the Phase 2 Global Constraints bind every task here.

**Specs:** `docs/superpowers/specs/2026-08-15-airlock-design.md` and `docs/superpowers/specs/2026-08-15-airlock-visual-design.md`.

**These tasks supersede parts of tasks 14 and 18.** Task 14 shipped a notification carrying one line of text. Task 18 shipped a launch handler that uploaded on arrival. Both are replaced here, and the earlier code is expected to be edited rather than extended.

---

### Task 24: Declining a transfer

**Files:**
- Modify: `transfers.go`
- Modify: `server.go`
- Test: `transfers_test.go`, `server_test.go`

**Interfaces:**
- Changed: `Transfer` and `Tombstone` gain `Declined []string`
- New: `func (t *Transfers) Decline(id, node string) error`
- New route: `POST /api/transfer/{id}/decline`

**Why this is a server change and not a button.** A Reject button that only closes a notification is a dismiss wearing a stronger word: the file still sits on the server, still counts against the quota, and still appears the next time the inbox is opened. Declining has to be recorded or it means nothing.

**What declining does.** It hides the transfer from the declining device. If the transfer was addressed to specific devices and every one of them has declined, it is deleted outright, because nothing will ever collect it. An unaddressed transfer is not deleted by one device declining, since the other devices were equally its destination; it simply stops appearing for whoever declined and expires on the usual TTL.

- [ ] **Step 1: Write the failing tests**

Append to `transfers_test.go`:

```go
func TestDeclineHidesFromTheDecliningDeviceOnly(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})

	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	desktop, _ := tr.Inbox("desktop")
	if len(desktop) != 0 {
		t.Fatal("a declined transfer should leave the decliner's inbox")
	}
	// Unaddressed means every device was its destination, so one refusal does
	// not speak for the others.
	laptop, _ := tr.Inbox("laptop")
	if len(laptop) != 1 {
		t.Fatalf("laptop sees %d, want the transfer still there", len(laptop))
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("the transfer itself should survive")
	}
}

func TestDeclineByEveryAddresseeDeletesTheTransfer(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop", "laptop"}, []string{cid(1)})

	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Get(rec.ID); err != nil {
		t.Fatal("one of two addressees declining must not delete it")
	}
	if err := tr.Decline(rec.ID, "laptop"); err != nil {
		t.Fatal(err)
	}
	// Nobody is left who could collect it.
	if _, err := tr.Get(rec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("the last addressee declining should delete the transfer")
	}
	hist, _ := tr.History("pixel")
	if len(hist) != 1 || len(hist[0].Declined) != 2 {
		t.Fatalf("the tombstone should record who declined: %+v", hist)
	}
}

func TestDeclineIsIdempotent(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Decline(rec.ID, "desktop"); err != nil {
		t.Fatal(err)
	}
	// The transfer is gone, so a repeat is a 404 rather than an error worth
	// surfacing to a user who tapped twice.
	if err := tr.Decline(rec.ID, "desktop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestDeclineTwiceOnAnUnaddressedTransferIsHarmless(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", nil, []string{cid(1)})
	for i := 0; i < 3; i++ {
		if err := tr.Decline(rec.ID, "desktop"); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	info, err := tr.Get(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Declined) != 1 {
		t.Fatalf("Declined = %v, want one entry", info.Declined)
	}
}

func TestDeclineRequiresVisibility(t *testing.T) {
	tr, _ := newTransfers(t)
	rec, _, _ := tr.Create("pixel", []string{"desktop"}, []string{cid(1)})
	if err := tr.Decline(rec.ID, "laptop"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a device it was never sent to", err)
	}
}
```

Append to `server_test.go`:

```go
func TestDeclineEndpoint(t *testing.T) {
	s, _ := newTestServer(t, true) // identity is node "pixel"
	id, _ := createTransfer(t, s, `{"cids":["`+cid(1)+`"],"to":["pixel"]}`)

	if code := do(t, s, "POST", "/api/transfer/"+id+"/decline", "").Code; code != http.StatusNoContent {
		t.Fatalf("decline = %d, want 204", code)
	}
	var inbox []map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/inbox", "").Body.Bytes(), &inbox)
	if len(inbox) != 0 {
		t.Fatalf("a declined transfer is still in the inbox: %v", inbox)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./...`
Expected: FAIL, undefined `Decline` and no `Declined` field.

- [ ] **Step 3: Implement in `transfers.go`**

Add `Declined []string \`json:"declined"\`` to both `Transfer` and `Tombstone`, carry it in `appendTombstone`, and add:

```go
func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// Decline records that a device does not want this transfer.
//
// It hides the transfer from that device. If the transfer named its recipients
// and every one of them has declined, it is deleted outright, because nobody is
// left who could collect it. An unaddressed transfer is not deleted by a single
// refusal, since every device was equally its destination; it stops appearing
// for the decliner and expires on the usual clock.
func (t *Transfers) Decline(id, node string) error {
	info, err := t.Get(id)
	if err != nil {
		return err
	}
	if !visibleTo(info.Sender, info.To, node) {
		return ErrNotFound
	}
	if contains(info.Declined, node) {
		return nil
	}

	rec := info.Transfer
	rec.Declined = append(append([]string{}, info.Declined...), node)

	dir, err := t.transferDir(id)
	if err != nil {
		return err
	}
	if err := t.writeJSON(dir, "meta.json", &rec); err != nil {
		return err
	}

	if len(rec.To) > 0 && allDeclined(rec.To, rec.Declined) {
		info.Transfer = rec
		return t.remove(info)
	}
	return nil
}

func allDeclined(to, declined []string) bool {
	for _, node := range to {
		if !contains(declined, node) {
			return false
		}
	}
	return true
}
```

In `Inbox`, add the filter next to the visibility check:

```go
		if visibleTo(info.Sender, info.To, node) && !contains(info.Declined, node) {
			out = append(out, info)
		}
```

**Note on `writeJSON`:** an earlier task removed it when `Create` moved to a temp-directory-then-rename publish. If it is gone, write the marshaled record with `atomicWrite` directly rather than reintroducing a helper with one caller.

- [ ] **Step 4: Add the route**

In `server.go`, register above the `{id}/{kind}` patterns so the literal path wins:

```go
	s.mux.HandleFunc("POST /api/transfer/{id}/decline", g(s.declineTransfer))
```

and append:

```go
func (s *Server) declineTransfer(w http.ResponseWriter, r *http.Request) {
	if fail(w, s.cfg.Transfers.Decline(r.PathValue("id"), who(r).Node)) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

Add `decline: (id) => req(\`/api/transfer/${id}/decline\`, { method: 'POST' })` to `web/api.js`.

- [ ] **Step 5: Verify and commit**

```bash
go vet ./... && go test ./... -v
git add transfers.go server.go transfers_test.go server_test.go web/api.js
git commit -m "feat(transfers): declining a transfer, with deletion once every addressee has"
```

---

### Task 25: Rich notifications with accept and decline

**Files:**
- Modify: `web/sw.js` (thumbnail route, rich push handler, action handling)
- Create: `web/icon-badge.png`
- Modify: `web/app.js`, `main.go`

**Interfaces:**
- Produces: a service-worker route `GET /thumb/{id}` returning a decrypted JPEG for use as the notification image.

**What "rich" means on this platform.** The Notification API gives a title, a body, a large `image`, a monochrome `badge`, a timestamp, and two action buttons. Every one of those has to be filled with something this device decrypts locally, because the push that woke us carries no payload by design and the server cannot read a filename.

So: the sending device as the title, the filename and size as the body, the transfer's own thumbnail as the image, and two buttons that both complete without ever opening the app. Accept downloads. Decline tells the server, so the file stops occupying space and stops reappearing.

**The thumbnail cannot be a `blob:` URL.** Notification images are fetched by the browser process rather than by page script, and a blob URL minted inside a worker is not reliably reachable from there. The worker serves it from a same-origin route it intercepts instead, exactly as it already does for `/dl/{id}`.

**Do not touch the download's `Content-Disposition`.** It comes from `contentDisposition()` in `web/naming.js`, which is covered by `web/naming.test.mjs`. Building that header inline is how a file called `holiday photo.jpg` ends up saved as `holiday%20photo.jpg`: the plain parameter is an ASCII fallback carrying the name literally, and only the starred parameter is percent-encoded. Leave the import and the call alone.

- [ ] **Step 1: Confirm the icons**

The icons are already generated and committed: `web/icon-192.png`, `web/icon-512.png`, `web/icon-maskable.png` and `web/icon-badge.png`. Do not write a new generator.

They come from `docs/assets/make-icons.py`, which is the single source for the mark and matches `docs/assets/logo.svg`. Regenerate only if the mark changes:

```bash
python docs/assets/make-icons.py
```

Two things that generator gets right and a naive one does not, so do not simplify it:

- **Supersampling.** Coverage is averaged over samples per pixel. Without it, rings come out visibly stair-stepped.
- **Real shapes.** The arrowhead is a triangle tested by barycentric sign, not a diagonal band approximated with an inequality. The band version produced a mangled chevron.

The bolt ring is derived from the gap between the two ring edges rather than from the midpoint of their centrelines, which are different points. Both rings carry the same stroke weight.


Open it and shrink it to about 24 pixels, which is roughly how it will be drawn. If the arrow disappears, thicken it rather than shipping a grey blob.

- [ ] **Step 2: Serve the thumbnail from the worker**

In `web/sw.js`, beside the existing `/dl/` interception:

```js
  if (event.request.method === 'GET' && url.pathname.startsWith('/thumb/')) {
    event.respondWith(thumbnail(url.pathname.slice(7)));
    return;
  }
```

```js
// Notification images are fetched by the browser process rather than by script,
// so a blob URL minted here is not reliably reachable from there. An ordinary
// same-origin URL this worker answers keeps the bytes decrypted on demand and
// the URL boring.
async function thumbnail(id) {
  const mk = await loadMaster();
  if (!mk) return new Response('locked', { status: 403 });
  try {
    const info = await (await fetch(`/api/transfer/${id}`)).json();
    if (!info.thumb) return new Response('no thumbnail', { status: 404 });
    const bytes = await openRecord(mk, DOMAIN.THUMB, id, b64decode(info.thumb));
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        // A transfer's thumbnail never changes, and the id is derived from the
        // transfer.
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new Response('cannot open', { status: 500 });
  }
}
```

- [ ] **Step 3: Replace the push handler**

Replace `announce()` in `web/sw.js`:

```js
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// The push that woke us says nothing, by design. Everything below is read from
// the inbox and decrypted on this device, which is the only place a filename
// exists in the clear.
async function announce() {
  const base = {
    icon: '/icon-192.png',
    badge: '/icon-badge.png',
    tag: 'airlock-generic',
  };

  let mk = null;
  let newest = null;
  try {
    mk = await loadMaster();
    [newest] = await (await fetch('/api/inbox')).json();
  } catch {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  if (!mk) {
    // Reachable but locked. Say so, because "a file is waiting" would leave the
    // owner wondering why tapping it shows nothing.
    return self.registration.showNotification('Airlock', {
      ...base, body: 'A file is waiting. Unlock this device to open it.',
    });
  }
  if (!newest || !newest.complete) {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(
      await openRecord(mk, DOMAIN.META, newest.id, b64decode(newest.meta))));
  } catch {
    return self.registration.showNotification('Airlock', { ...base, body: 'A file is waiting' });
  }

  const options = {
    body: `${meta.name}\n${humanSize(meta.size)}`,
    icon: '/icon-192.png',
    badge: '/icon-badge.png',
    // One tag per transfer, so several arrivals stack. A shared tag would
    // silently hide everything but the last file.
    tag: `airlock-${newest.id}`,
    timestamp: new Date(newest.createdAt).getTime(),
    data: { id: newest.id, name: meta.name },
    // Two is the practical maximum Android renders. Dismissing is already a
    // swipe, so neither button is spent on it.
    actions: [
      { action: 'accept', title: 'Accept' },
      { action: 'decline', title: 'Decline' },
    ],
    requireInteraction: true,
  };
  if (newest.thumb) options.image = `/thumb/${newest.id}`;

  // The title is the sending device, because on a personal tailnet the useful
  // question is which of my machines this came from.
  return self.registration.showNotification(newest.sender, options);
}
```

- [ ] **Step 4: Handle the actions**

```js
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;

  event.waitUntil((async () => {
    // Decline completes entirely in here. No window opens, and the server stops
    // holding a file nobody wanted.
    if (event.action === 'decline' && id) {
      try {
        await fetch(`/api/transfer/${id}/decline`, { method: 'POST' });
      } catch {
        // The tailnet is down. The transfer simply stays in the inbox, which is
        // the same place it would have been anyway.
      }
      return;
    }
    // Accept downloads without opening the app first: this worker answers /dl/,
    // so the navigation returns an attachment and the browser saves it with its
    // own progress UI.
    if (event.action === 'accept' && id) {
      return self.clients.openWindow(`/dl/${id}`);
    }
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        client.postMessage({ type: 'show', view: 'inbox' });
        return;
      }
    }
    return self.clients.openWindow('/#inbox');
  })());
});
```

In `web/app.js`, act on that message inside `enterApp()`:

```js
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'show') showView(event.data.view);
  });
```

- [ ] **Step 5: Add a Decline button to the inbox**

A notification is not the only place a transfer is refused, and an action available in one place and not the other is the kind of inconsistency people notice. In `web/views/inbox.js`, beside Save and Delete:

```js
    actions.append(el('button', {
      class: 'ghost', type: 'button',
      onclick: async () => { await api.decline(t.id); await refresh(); },
    }, 'Decline'));
```

Delete removes a transfer for everyone. Decline removes it for you. Keep both, and keep the labels distinct.

- [ ] **Step 6: Embed the badge and verify**

Add `web/icon-badge.png` to the `//go:embed` directive in `main.go`.

Push needs a trusted certificate, so these run against the deployed tailnet server. On the phone:

1. Send a **photo**. The notification shows the sending device as the title, filename and size as the body, and the photo as a large image, with Accept and Decline buttons.
2. Tap **Accept** without opening the app. The file downloads.
3. Send another and tap **Decline**. Nothing opens, and the transfer is gone from the inbox on every device it was addressed to.
4. Send a **PDF**. Same notification without the image, nothing broken by its absence.
5. Send two files quickly and confirm **two** notifications rather than one replacing the other.
6. Clear IndexedDB, send a file, and confirm the notification says to unlock rather than showing a name it cannot read.
7. Turn Tailscale off and tap Decline. It fails quietly and the transfer stays in the inbox, which is where it would have been anyway.
8. Confirm the status-bar badge is a legible silhouette.

- [ ] **Step 7: Commit**

```bash
git add web/sw.js web/icon-badge.png web/app.js web/views/inbox.js main.go
git commit -m "feat(push): rich notifications with thumbnail, accept and decline"
```

---

### Task 26: Staged send and the Windows context menu

**Files:**
- Modify: `web/views/send.js`, `web/app.js`, `web/manifest.webmanifest`, `web/app.css`
- Create: `deploy/windows/install-context-menu.ps1`, `deploy/windows/uninstall-context-menu.ps1`
- Modify: `README.md`

**Two changes, one intent: nothing leaves the machine before you choose where it goes.**

Task 18 wired the file handler and the share target to upload on arrival. That is wrong for a product whose point is picking a destination. Both paths now stage files in the Send view with the recipient picker in reach.

**On the Windows entry.** A browser-only product cannot install a shell extension and should not try. What it can do is register a per-user context-menu command pointing at the launcher Chrome or Edge already creates when the PWA is installed. That launcher takes a file path and hands it to `launchQueue`, the same path the Open with menu uses. One registry key, no binary, no administrator.

A helper that uploaded straight from the shell is rejected for the same reason the native Android client was: it would need the passphrase, and it would become a second implementation of the encryption.

- [ ] **Step 1: Stage instead of sending**

In `web/views/send.js`, add a staging list above the view definition:

```js
// Files wait here until the owner picks a destination and presses Send. Nothing
// uploads on arrival, whether it came from the drop zone, the Android share
// sheet, or the Windows context menu: choosing where a file goes is the product.
const staged = [];
let renderStaged = () => {};

export function stageFiles(files) {
  staged.push(...files);
  renderStaged();
}

export function stageText(text) {
  const name = `${text.slice(0, 40).replace(/\s+/g, ' ').trim() || 'note'}.txt`;
  staged.push(new File([text], name, { type: 'text/plain' }));
  renderStaged();
}
```

Inside the mount function:

```js
  const stagedList = el('ul', { class: 'rows staged' });
  const sendButton = el('button', { class: 'primary', type: 'button', disabled: true }, 'Send');

  renderStaged = () => {
    stagedList.replaceChildren();
    staged.forEach((file, i) => {
      stagedList.append(el('li', {},
        el('div', {},
          el('div', { class: 'name' }, file.name),
          el('div', { class: 'data muted' }, humanSize(file.size))),
        el('div', { class: 'actions' },
          el('button', {
            class: 'ghost', type: 'button',
            'aria-label': `Remove ${file.name}`,
            onclick: () => { staged.splice(i, 1); renderStaged(); },
          }, 'Remove'))));
    });
    sendButton.disabled = staged.length === 0;
    sendButton.textContent = staged.length > 1 ? `Send ${staged.length} files` : 'Send';
  };

  sendButton.addEventListener('click', async () => {
    const files = staged.splice(0, staged.length);
    renderStaged();
    await sendNow(files);
  });
```

Append `stagedList` and `sendButton` between the recipient picker and the progress area, and call `renderStaged()` at the end of mount so a share that arrived before the view mounted is shown.

The drop zone and the file picker now call `stageFiles`. `sendNow` holds what the old `send` function did.

- [ ] **Step 2: Point the launch paths at staging**

In `web/app.js`, replace `handleLaunch()`:

```js
async function handleLaunch() {
  const stage = async (fn, ...args) => {
    showView('send');
    const send = await import('./views/send.js');
    send[fn](...args);
  };

  if (new URLSearchParams(location.search).has('share')) {
    const pending = await kvGet('pending-share');
    await kvPut('pending-share', null);
    history.replaceState(null, '', '/');
    if (pending?.files?.length) await stage('stageFiles', pending.files);
    else if (pending?.text) await stage('stageText', pending.text);
  }

  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      await stage('stageFiles', await Promise.all(params.files.map((h) => h.getFile())));
    });
  }
}
```

- [ ] **Step 3: Broaden the handled types**

Chrome matches `file_handlers` on concrete MIME types, so Open with only appears for what the manifest lists. Replace the `accept` map in `web/manifest.webmanifest`:

```json
      "accept": {
        "application/octet-stream": [".bin", ".iso", ".img", ".dmg", ".apk"],
        "application/pdf": [".pdf"],
        "application/zip": [".zip"],
        "application/x-7z-compressed": [".7z"],
        "application/x-tar": [".tar", ".gz", ".tgz"],
        "application/msword": [".doc"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
        "application/vnd.ms-excel": [".xls"],
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
        "application/json": [".json"],
        "image/jpeg": [".jpg", ".jpeg"],
        "image/png": [".png"],
        "image/gif": [".gif"],
        "image/webp": [".webp"],
        "image/heic": [".heic"],
        "image/tiff": [".tif", ".tiff"],
        "text/plain": [".txt", ".log", ".md", ".csv"],
        "video/mp4": [".mp4", ".m4v"],
        "video/quicktime": [".mov"],
        "video/x-matroska": [".mkv"],
        "audio/mpeg": [".mp3"],
        "audio/flac": [".flac"],
        "audio/wav": [".wav"]
      }
```

The registry entry covers every other extension, which is why this list does not have to be exhaustive.

- [ ] **Step 4: Write the context-menu installer**

`deploy/windows/install-context-menu.ps1`:

```powershell
# Adds "Send with Airlock" to the right-click menu for every file type.
#
# This registers a per-user command pointing at the launcher Chrome or Edge
# already creates when the PWA is installed. That launcher hands the file to the
# app's launchQueue, the same path the Open with menu uses, so there is no second
# uploader and no second copy of the encryption.
#
# HKCU only: no administrator, and it uninstalls cleanly.

$ErrorActionPreference = 'Stop'

$roots = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:LOCALAPPDATA\Chromium\User Data"
) | Where-Object { Test-Path $_ }

if (-not $roots) {
    throw "No Chrome, Edge or Chromium profile found. Install Airlock as an app first."
}

# Scoped to the browser profile directories rather than a disk sweep.
$launcher = $roots |
    ForEach-Object { Get-ChildItem -Path $_ -Filter 'Airlock.exe' -Recurse -ErrorAction SilentlyContinue } |
    Where-Object { $_.FullName -like '*Web Applications*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $launcher) {
    throw "Airlock is not installed as an app yet. Open it in Chrome or Edge, install it from the address bar, then run this again."
}

$key = 'HKCU:\Software\Classes\*\shell\Airlock'
New-Item -Path $key -Force | Out-Null
New-Item -Path "$key\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value 'Send with Airlock'
Set-ItemProperty -Path $key -Name 'Icon' -Value "$($launcher.FullName),0"
Set-ItemProperty -Path "$key\command" -Name '(Default)' -Value "`"$($launcher.FullName)`" `"%1`""

Write-Output "Installed. Right-click any file and choose 'Send with Airlock'."
Write-Output "Launcher: $($launcher.FullName)"
```

`deploy/windows/uninstall-context-menu.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Classes\*\shell\Airlock'
if (Test-Path $key) {
    Remove-Item -Path $key -Recurse -Force
    Write-Output "Removed."
} else {
    Write-Output "Nothing to remove."
}
```

- [ ] **Step 5: Style the staging list**

Append to `web/app.css`:

```css
.staged li:first-child { border-top: 1px solid var(--seam); }
.staged + button.primary { margin-top: var(--gap); }
```

- [ ] **Step 6: Document it**

Replace the Open with line in the README's Windows section:

```markdown
Right-click any file and choose **Send with Airlock**. The app opens with the
file staged, so you pick the destination before anything leaves the machine.

Install the entry once, after installing the app itself:

    powershell -ExecutionPolicy Bypass -File deploy\windows\install-context-menu.ps1

It writes one per-user registry key pointing at the launcher your browser already
created, needs no administrator, and `uninstall-context-menu.ps1` removes it.
Dragging a file onto the window works with no setup at all.
```

- [ ] **Step 7: Verify**

1. Drop three files. All three stage, nothing uploads.
2. Remove one. The button reads `Send 2 files`.
3. Pick a destination and press Send. Both upload and the list empties.
4. With nothing staged, Send is disabled.
5. Run the installer, right-click a file with an extension in no list, and choose Send with Airlock. The app opens with it staged.
6. Share a photo from Android. The app opens with it staged and unsent.
7. Run the uninstaller and confirm the entry is gone.
8. Run the installer *before* installing the PWA and confirm it fails with the message telling you to install the app first, rather than writing a broken key.

- [ ] **Step 8: Commit**

```bash
git add web/views/send.js web/app.js web/manifest.webmanifest web/app.css deploy/windows README.md
git commit -m "feat(send): stage files for an explicit send, and a windows context menu entry"
```
