# Deploy Airlock on a VPS and add an Android device

This guide takes a new VPS from an empty Linux host to a private Airlock URL,
then adds a trusted desktop and an Android phone. It uses the repository's
Docker Compose deployment, in which Airlock joins the tailnet as its own
embedded Tailscale node.

If you prefer to install a native binary, the [Linux systemd
instructions](../README.md#linux-systemd) remain the lowest-risk deployment on
real hardware today. Docker is easier to reproduce and isolate, but Airlock's
embedded mode and the Android path still need to be recorded against a real VPS
and phone in [platform-notes.md](platform-notes.md). The image, Compose
configuration, and local HTTP smoke path are tested in this repository; this
guide does not turn an outstanding hardware check into a claim.

## What you are building

```text
Android Chrome/PWA ─┐
                    ├─ Tailscale tailnet ─ Airlock's embedded tsnet node
Trusted desktop ────┘                         │
                                             └─ Docker volume: airlock-data
```

There is no public Airlock port, public DNS record, nginx/Caddy proxy, Tailscale
Serve rule, or Funnel. The container establishes an outbound Tailscale
connection and listens inside that private network. Every stateful request is
then tied to the calling Tailscale user and node with `WhoIs`.

The single persistent volume contains both Airlock's state and the embedded
Tailscale identity. Replacing a container is safe. Deleting the volume destroys
that state; copying it is safe only while the original and copy are never run
at the same time.

## Before you begin

You need:

- A Linux VPS with a persistent local disk. Ubuntu 22.04 or 24.04 is the
  command path shown below; use Docker's distribution-specific instructions on
  another Linux.
- SSH access with `sudo`.
- A Tailscale account in which you may add a server and your phone.
- One trusted desktop or laptop already connected to that tailnet. Use it as
  the first Airlock device and as the administrator for later devices.
- An Android 8 or newer phone for the Android path. Tailscale's current Android
  client supports Android 8.0 and later.
- Enough VPS disk for transfers held while a recipient is offline. CPU and RAM
  needs are modest; encrypted queued content is what consumes space.

Choose these values before starting:

| Value | Example | Why it matters |
| --- | --- | --- |
| Server node name | `airlock` | Becomes part of the HTTPS URL and a public Certificate Transparency entry |
| Allowed Tailscale login | `you@example.com` | The human identity permitted to register Airlock devices |
| Airlock passphrase | A long, unique password-manager entry | Derives the encryption key on every paired browser; it never goes to the server |
| Storage ceiling | `107374182400` for 100 GiB | Prevents queued ciphertext from filling the VPS |
| Transfer lifetime | `24` hours | Removes transfers inactive for that many hours |

> **Keep the Airlock passphrase.** There is no recovery or automatic key handoff
> today. Every device enters the same passphrase. If both the passphrase and all
> paired-browser state are lost, existing encrypted transfers cannot be opened.

## 1. Prepare the tailnet

### Enable MagicDNS and HTTPS

Open the Tailscale admin console's **DNS** page:

1. Enable **MagicDNS**.
2. Under **HTTPS Certificates**, select **Enable HTTPS**.
3. Read and accept the certificate-transparency notice.

The browser URL will be a fully qualified name such as:

```text
https://airlock.yak-bebop.ts.net/
```

Use the exact URL Airlock prints at startup. Do not substitute the VPS public
IP, the Tailscale `100.x` address, a short `https://airlock` name, or plain
HTTP. The certificate covers the fully qualified `*.ts.net` name.

HTTPS certificate names are written to public Certificate Transparency logs.
The IP and service remain private, but the name becomes public, so use a neutral
node name. See Tailscale's current [HTTPS certificate
instructions](https://tailscale.com/docs/how-to/set-up-https-certificates) and
[MagicDNS documentation](https://tailscale.com/docs/features/magicdns).

### Check the tailnet access policy

A new personal tailnet normally permits its devices to communicate. If you
have a restrictive policy, it must allow:

- Your client devices to reach the Airlock node on `tcp:443`.
- Client devices belonging to the same user to reach one another for direct
  WebRTC transfers. The browser selects dynamic ports, so a server-only
  `tcp:443` rule is not enough for direct delivery.

Tailscale's current policy language is [grants](https://tailscale.com/docs/features/access-control/grants),
and its [self-device example](https://tailscale.com/docs/reference/examples/grants#allow-users-access-to-their-own-devices)
uses `autogroup:self` to permit one user's devices to communicate. Merge any
Airlock rule into the existing policy and use the admin console's preview; do
not replace unrelated SSH, exit-node, or subnet-router rules with a copied
example. If you cannot permit client-to-client traffic, use **Hold on the
server if I go offline** for those transfers.

### Create the server's one-time auth key

Open the Tailscale admin console's **Keys** page and generate an auth key with:

- **Reusable:** off.
- **Ephemeral:** off. The server must retain one stable identity.
- **Pre-approved:** on if Tailscale device approval is enabled.
- **Tags:** none for the simplest personal deployment.

If Tailnet Lock is enabled, the auth key must also be pre-signed or signed by a
trusted signing node. **Pre-approved** device admission and Tailnet Lock signing
are separate checks; enabling the former does not satisfy the latter.

Copy the key once and keep that page open. Do not put it in Git, `.env`,
`compose.yaml`, a Docker image, or a command that will be saved in shell
history. A one-off key is enough because the Docker volume preserves the
embedded node state. Tailscale documents the key types and their security
tradeoffs in [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys)
and [Securely handle an auth key](https://tailscale.com/docs/features/access-control/auth-keys/how-to/secure-auth-keys).

An advanced deployment may tag the server `tag:airlock`. Tagged server keys
have useful non-human lifecycle semantics, but Airlock can no longer infer a
human owner from that node. If you use a tag, set `AIRLOCK_ALLOW_USERS` in
`.env` to the exact login or comma-separated logins allowed to use Airlock.
Never tag an Android or other end-user client: Airlock deliberately rejects
tagged callers.

## 2. Install Docker on the VPS

If Docker Engine and the `docker compose` plugin are already installed, verify
them and skip to the next section:

```bash
sudo docker version
sudo docker compose version
```

For Ubuntu, the following is Docker's current repository-based installation
path. Docker recommends its convenience script only for testing and
development. Check the [official Ubuntu installation
page](https://docs.docker.com/engine/install/ubuntu/) before running this on a
newer distribution release.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nano
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
sudo docker compose version
```

This guide keeps `sudo` in every Docker command. Adding a user to the `docker`
group is optional, and Docker documents that group as root-level access to the
host.

## 3. Configure Airlock

Clone the repository and create the local configuration file:

```bash
git clone https://github.com/ahnafnafee/airlock.git
cd airlock
cp .env.example .env
nano .env
```

The template starts with these values:

```dotenv
AIRLOCK_HOSTNAME=airlock
AIRLOCK_DATA_VOLUME=airlock-data
AIRLOCK_TTL_HOURS=24
AIRLOCK_MAX_TOTAL=214748364800
AIRLOCK_VAPID_SUBJECT=mailto:you@example.com
AIRLOCK_ALLOW_USERS=
AIRLOCK_ALLOW_NODES=
```

Edit `AIRLOCK_VAPID_SUBJECT`, and set `AIRLOCK_MAX_TOTAL` below the space
actually available on the VPS; 200 GiB is a template value, not a safe value
for every disk. The VAPID subject is the contact address included in Web Push
authentication, not a notification recipient. Keep
`AIRLOCK_ALLOW_USERS` blank for an untagged server enrolled by the same account
that will use Airlock. For a tagged server, set the exact Tailscale login, for
example `AIRLOCK_ALLOW_USERS=you@example.com`.

`AIRLOCK_MAX_TOTAL` is bytes, not a value such as `100GiB`:

| Ceiling | Bytes |
| --- | ---: |
| 50 GiB | `53687091200` |
| 100 GiB | `107374182400` |
| 200 GiB | `214748364800` |

Leave disk headroom for the operating system, Docker layers, temporary writes,
and backups. The ceiling covers Airlock's records and chunks, not everything on
the VPS.

The supplied Compose service:

- Builds a pinned, multi-stage Go image.
- Runs as an unprivileged user in a read-only container.
- Gives write access only to `/var/lib/airlock` and a small temporary
  filesystem.
- Persists the named volume from `AIRLOCK_DATA_VOLUME`.
- Enables Airlock's own per-device approval.
- Publishes **no Docker ports**.

Do not add a `ports:` section. Do not put nginx, Caddy, Cloudflare, Tailscale
Serve, or Funnel in front of it. A proxy hides the caller address Airlock uses
for `WhoIs`; Funnel additionally makes the service public.

## 4. Start the server for the first time

Read the one-off auth key without placing it in shell history, export it for
this one Compose invocation, and build the container:

```bash
read -rsp "Paste the one-off Tailscale auth key: " TS_AUTHKEY
echo
export TS_AUTHKEY
sudo --preserve-env=TS_AUTHKEY docker compose up -d --build
unset TS_AUTHKEY
```

Watch the startup log:

```bash
sudo docker compose logs --tail=100 -f airlock
```

Wait for lines like these:

```text
embedded mode, allowing tailnet users [you@example.com]
open https://airlock.yak-bebop.ts.net/ on any device on your tailnet
```

Press `Ctrl+C`; that only stops following the logs, not the container. Save the
exact URL in your password manager alongside the Airlock passphrase.

If the server appears in Tailscale's Machines page as **Needs approval**, approve
it there. A pre-approved key avoids that extra step. If the log still has no
URL, return to the troubleshooting section before opening any firewall port.

### Remove the bootstrap key from container metadata

The first container was created with the auth key in its environment. The node
identity now lives in the persistent volume, so recreate the container with an
empty key and confirm it starts from saved state:

```bash
unset TS_AUTHKEY
sudo docker compose up -d --force-recreate
sudo docker compose logs --tail=100 -f airlock
```

Wait until the saved-state start prints the same `open https://...` URL, then
press `Ctrl+C` to stop following the log.

Confirm the recreated container stores only an empty value:

```bash
container_id=$(sudo docker compose ps -q airlock)
sudo docker inspect "$container_id" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^TS_AUTHKEY='
```

Expected output:

```text
TS_AUTHKEY=
```

Verify the bootstrap key shows as revoked on Tailscale's Keys page; Tailscale
automatically revokes a one-off key after use, so revoke it manually only if it
still appears active. On the Machines page, find the `airlock` server and choose
**Disable Key Expiry** for this unattended runbook. An expired embedded server
node stops all tailnet access, and Airlock's interactive `tsnet`
reauthentication path has not been hardware-validated. If organizational policy
requires expiry, test that recovery on console access before depending on the
server remotely, or use the native host-mode deployment whose Tailscale login
is managed on the host. See [Key expiry](https://tailscale.com/docs/features/access-control/key-expiry).

No VPS inbound port needs to be opened for this deployment. Keep SSH access as
you normally would and permit outbound connectivity for Docker/Tailscale and
Web Push. Tailscale's [firewall guidance](https://tailscale.com/docs/reference/faq/firewall-ports)
describes optional UDP optimizations; opening a public TCP 443 port is not one
of them.

## 5. Set up the first trusted Airlock device

Do this before opening Airlock on the phone. Even with `--require-approval`, a
brand-new Airlock registry admits its first device so there is someone able to
approve later devices.

On the trusted desktop or laptop:

1. Confirm the Tailscale client is connected to the same tailnet and the server
   appears online.
2. Open the exact logged HTTPS URL in Chrome, Edge, Firefox, or Safari. Do not
   use the VPS IP.
3. Airlock should show **Choose a passphrase**. Create the long, unique
   passphrase selected earlier and save it in a password manager.
4. Enter the application. Open **Devices** and verify the current node is shown
   as **Sealed** and marked **this device**.
5. Optionally install the web app from the browser's install control and allow
   notifications when asked.

The passphrase derives a master key in the browser. Airlock sends a sealed
verifier rather than the passphrase, so the server cannot reveal or reset it.
Anyone who obtains the server state can still test passphrase guesses offline
against that verifier; this is why the passphrase must be long and unique.

## 6. Add and register an Android phone

There are two approvals. Complete them in this order:

1. **Tailscale approval** admits the phone to the private network.
2. **Airlock approval** admits that Tailscale node to the application.

Approving one does not approve the other.

### A. Join the Android phone to Tailscale

1. Install the official **Tailscale** app from Google Play.
2. Open it, select **Get Started**, accept Android's VPN-configuration prompt,
   and allow Tailscale notifications so it can warn about reauthentication.
3. Sign in to the same tailnet with the human account permitted by
   `AIRLOCK_ALLOW_USERS`. Do not enroll the phone with a tag.
4. Turn the Tailscale connection on.
5. If the tailnet has device approval enabled, an Owner, Admin, or IT admin
   must open the Tailscale **Machines** page, find the Android node marked
   **Needs approval**, and choose **Approve**. Until then, the phone cannot
   exchange tailnet traffic at all.
6. Confirm both the phone and the `airlock` server show as online.

These labels follow Tailscale's current [Android installation](https://tailscale.com/docs/install/android)
and [device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)
instructions.

### B. Install and approve Airlock

1. In Android Chrome, open the full HTTPS URL from the server log.
2. Before pairing, use Chrome's menu or install prompt to choose **Install app**
   or **Add to Home screen**. Launch Airlock from the new icon. Menu wording can
   vary by Chrome version.
3. Airlock displays the Tailscale node name and waits for approval.
4. On the already trusted desktop, open Airlock's **Devices** view.
5. Match the waiting node name to the Android device in Tailscale's Machines
   page, then select **Approve** in Airlock.
6. The phone should advance without a reload. Enter the same Airlock
   passphrase used on the desktop.
7. Allow browser notifications if prompted.
8. Back on the desktop's **Devices** view, verify the phone is **Sealed**. On
   the phone, verify the desktop appears as an available recipient in **Send**.

The installed Chrome app is expected to register Airlock in Android's share
sheet because the manifest includes a Web Share Target. This remains a
physical-device acceptance item for this repository. Verify it rather than
assuming it:

1. Open Gallery or Files.
2. Select a small, non-sensitive file and tap **Share**.
3. Choose **Airlock**.
4. Confirm the file is merely staged; choose a recipient and tap **Send** in
   Airlock.

If Airlock is absent from the share sheet, use its in-app **Choose files**
button and record the Android, Chrome, and Tailscale versions in
[platform-notes.md](platform-notes.md). The implemented Firefox-for-Android
fallback is Airlock's picker, not the installed PWA/share-target path; that
physical-browser fallback is also awaiting a recorded check.

## 7. Verify end-to-end delivery

Use non-sensitive test files first.

### Direct transfer

1. Keep Airlock open and awake on both the desktop and Android phone.
2. On the desktop, choose a small file.
3. In **To**, choose the Android node explicitly.
4. Leave **Hold on the server if I go offline** off and tap **Send**.
5. On Android, open **Inbox**, save the file, and compare its bytes or checksum
   with the source.
6. Repeat in the other direction.

Direct delivery stages encrypted chunks on the sender and transfers them over a
tailnet WebRTC data channel. The VPS coordinates the session but does not hold
file content. If the sender never opens Airlock again, a queued direct transfer
cannot finish.

### Held/offline transfer

1. Choose a second file and the Android recipient.
2. Enable **Hold on the server if I go offline**.
3. Tap **Send** and wait for the `Sent …` confirmation.
4. Close Airlock on the sender.
5. Open Android's **Inbox** and save the file.

This path stores sealed chunks on the VPS so the recipient does not have to
overlap with the sender. Test a zero-byte file as well: it should arrive and
save as an empty file.

### Notification and restart checks

1. With Airlock installed on Android and notification permission granted, send
   two small held files quickly. Confirm two arrivals are represented.
2. Restart the service:

   ```bash
   sudo docker compose restart airlock
   sudo docker compose logs --tail=50 airlock
   ```

3. Reopen Airlock on both devices. Their approval and pairing state, Inbox, and
   the server URL should survive.

## Day-two operations

Start every command in this section from the repository checkout:

```bash
cd /path/to/airlock
```

### Status and logs

```bash
sudo docker compose ps
sudo docker compose logs --tail=200 airlock
sudo docker compose logs -f airlock
```

Airlock does not currently expose a health or metrics endpoint, and an embedded
`tsnet` listener is not a conventional localhost container port. That is why
`compose.yaml` does not pretend a local Docker health check proves tailnet
readiness. The meaningful check is opening the logged URL from an allowed
tailnet device and loading **Devices** or **Inbox**.

To inspect volume usage without changing it:

```bash
sudo docker run --rm \
  -v airlock-data:/data:ro \
  alpine:3.22 du -sh /data
```

Replace `airlock-data` if `AIRLOCK_DATA_VOLUME` uses another name.

### Update and roll back

Update only when no transfer is actively uploading or assembling. First
complete [a stopped-volume backup](#back-up-the-complete-state), then run:

```bash
cd /path/to/airlock
git status --short
git pull --ff-only
sudo docker image tag airlock:local airlock:rollback
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose logs --tail=100 airlock
```

Run the direct and held smoke transfers again. If the new image cannot start,
restore the previous local image and recreate the service:

```bash
sudo docker image tag airlock:rollback airlock:local
sudo docker compose up -d --no-build --force-recreate
```

An image rollback does not roll back durable data.

### Back up the complete state

The volume includes the encryption salt, verifier, device registry, transfer
records, ciphertext chunks, push keys and subscriptions, and the embedded
Tailscale node state. Treat the archive as sensitive. A backup of only
`chunks/` is not a recoverable backup.

Stop Airlock so the archive is a consistent point in time:

```bash
cd /path/to/airlock
install -d -m 0700 backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="airlock-$stamp.tar.gz"
config_backup="airlock-$stamp.env"
revision_backup="airlock-$stamp.commit"
cp .env "backups/$config_backup"
git rev-parse HEAD >"backups/$revision_backup"
chmod 0600 "backups/$config_backup" "backups/$revision_backup"

sudo docker compose stop airlock
sudo docker run --rm \
  -v airlock-data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.22 sh -c \
  'umask 077; tar -C /source -czf "/backup/$1" .' sh "$backup"
sudo chown "$(id -u):$(id -g)" "backups/$backup"
chmod 0600 "backups/$backup"
sudo docker compose start airlock

sudo tar -tzf "backups/$backup" >/dev/null
sudo tar -tzf "backups/$backup" | sed -n '1,10p'
sudo docker compose logs --tail=50 airlock
```

Replace `airlock-data` if configured differently. The same-stamped `.env` and
`.commit` files record the configuration and matching source revision; `.env`
must never contain `TS_AUTHKEY`. Copy all three files to encrypted backup
storage outside the VPS. A server backup does not include browser IndexedDB or
OPFS state; pending direct-transfer chunks may exist only on the sending
browser.

### Test a restore without overwriting production

Never start two copies of the same restored embedded Tailscale state at once.
The following prepares a separate volume while production is stopped:

```bash
cd /path/to/airlock
sudo docker compose stop airlock
archive="REPLACE_WITH_BACKUP.tar.gz"
restore_volume="airlock-data-restore-$(date -u +%Y%m%dT%H%M%SZ)"

test -f "backups/$archive" || { echo "Backup not found: $archive"; exit 1; }
if sudo docker volume inspect "$restore_volume" >/dev/null 2>&1; then
  echo "Refusing to reuse existing volume: $restore_volume"
  exit 1
fi

sudo docker volume create "$restore_volume"
sudo docker run --rm \
  -v "${restore_volume}:/restore" \
  -v "$PWD/backups:/backup:ro" \
  alpine:3.22 sh -c \
  'cd /restore && tar -xzf "/backup/$1" && chown 65532:65532 . && chmod 0700 .' \
  sh "$archive"
printf 'Set AIRLOCK_DATA_VOLUME=%s in .env\n' "$restore_volume"
```

Then set the printed name in `.env`, for example:

```dotenv
AIRLOCK_DATA_VOLUME=airlock-data-restore-20260816T220000Z
```

Start exactly one Airlock instance and validate it from a tailnet device:

```bash
sudo docker compose up -d --force-recreate
sudo docker compose logs --tail=100 airlock
```

Keep the original volume until the restored service has passed the acceptance
checklist. To return to it, stop the service first, restore the original saved
`AIRLOCK_DATA_VOLUME` value from the backup's `.env` file, and recreate the
container. Never attach one volume to multiple Airlock replicas or run both
cloned identities concurrently.

> **Destructive command to avoid:** `docker compose down -v` removes the named
> volume and therefore the Airlock store and embedded Tailscale identity.
> Ordinary `docker compose down` leaves the named volume intact.

### Revoke a lost device

1. From another trusted Airlock device, open **Devices** and revoke the lost
   node.
2. In Tailscale's Machines page, disable or remove that Android/desktop device.
3. Review queued transfers and delete anything it should no longer receive.

These are separate controls. Airlock revocation blocks future application
calls, but it cannot erase a key or files the lost device already learned.
There is no in-place Airlock passphrase rotation today; a suspected key
compromise requires deliberately creating fresh server state and pairing the
remaining devices under a new passphrase.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Container repeatedly exits before printing a URL | `docker compose logs airlock`; verify the first start received a valid, non-ephemeral auth key, Tailscale approved the server, and the volume is writable |
| Server cannot join a Tailnet Lock-enabled tailnet | Pre-sign the auth key or sign it from a trusted signing node; **Pre-approved** device admission alone does not satisfy Tailnet Lock |
| `this tailnet has no HTTPS certificate domains` | Enable MagicDNS and HTTPS Certificates on Tailscale's DNS page, then restart the container |
| Android says the site cannot be reached | Turn on the Android Tailscale connection, approve the phone in Tailscale if needed, confirm the server is online, and use the full logged `https://...ts.net/` URL |
| TLS certificate error | Do not use a public IP, `100.x` IP, short hostname, or plain HTTP; use the exact fully qualified name from logs |
| Shell loads but reports `not authorized` | Confirm the phone's Tailscale login is in `AIRLOCK_ALLOW_USERS`, its node is not excluded by `AIRLOCK_ALLOW_NODES`, and the request is not passing through a proxy or Serve rule |
| Phone remains at Tailscale **Needs approval** | Approve it in the Tailscale Machines page; Airlock cannot see a phone that cannot yet exchange tailnet traffic |
| Phone reaches Airlock but waits for approval | On an already admitted Airlock device, open **Devices**, match the node name, and select **Approve** |
| Passphrase is rejected | Enter the exact passphrase chosen on the first Airlock device. There is no reset that preserves encrypted queued data |
| Desktop and phone see the server but direct transfer stalls | Keep both Airlock apps open and verify grants allow client-to-client traffic, not only client-to-server `tcp:443`; use held delivery as a diagnostic |
| Held transfer is refused | Check `AIRLOCK_MAX_TOTAL`, free VPS disk, the transfer TTL, and container logs |
| Android share target is missing | Install from Chrome, launch the installed icon once, and retry; use **Choose files** if the browser/OS does not register the target |
| No notification | Check Android and Chrome notification permission and whether the installed app was opened after pairing; Inbox remains authoritative even when push is unavailable |
| Port 443 looks occupied on the VPS | Embedded Docker mode does not bind the host's public port. Do not add a proxy or `ports:` mapping; inspect whether the error is actually a tailnet policy/certificate issue |
| Startup works only while `TS_AUTHKEY` is set | The data volume is not persisting `<data>/tsnet`, or an ephemeral key was used. Stop and fix persistence before repeatedly registering new nodes |

Do not try to fix authorization with Tailscale Serve or Funnel. Serve normally
reverse-proxies from loopback, where Airlock cannot prove the original caller;
Funnel is public by design. If another tailnet service owns a port in native
host mode, give Airlock a different port such as 4443 and include that port in
the URL and grants.

## Security and production checklist

- [ ] MagicDNS and HTTPS Certificates are enabled; the neutral hostname is
  acceptable in public Certificate Transparency logs.
- [ ] The Compose service has no `ports:` entry and the VPS firewall exposes no
  Airlock port publicly.
- [ ] The bootstrap auth key was one-off/non-ephemeral, removed from the
  recreated container, and revoked in Tailscale.
- [ ] The server node's key-expiry policy is deliberate.
- [ ] `AIRLOCK_ALLOW_USERS` and optional `AIRLOCK_ALLOW_NODES` match the people
  and devices intended to use the service.
- [ ] The trusted desktop was the first Airlock device and holds the saved
  passphrase.
- [ ] Android passed both Tailscale approval and Airlock approval, then appears
  as **Sealed**.
- [ ] A direct file transferred byte-for-byte in both directions.
- [ ] A held file and a zero-byte file arrived after the sender closed.
- [ ] Android install, notification, and share-target behavior was recorded
  with OS, Chrome, and Tailscale versions.
- [ ] Restart preserved the URL, paired devices, queue, and history.
- [ ] The entire named volume is backed up off-host and a restore was tested
  without running two copies of its embedded Tailscale identity.
- [ ] Custom Tailscale grants permit both client-to-server HTTPS and the desired
  client-to-client direct-transfer path.

For the source research and version-sensitive caveats behind this runbook, see
[deployment-research.md](deployment-research.md). For the native alternative
and all server flags, see the [README installation section](../README.md#-installation).
