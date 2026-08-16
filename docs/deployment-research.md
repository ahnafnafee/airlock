# Deployment research: VPS, Docker, Tailscale, and Android

Research date: 2026-08-16

This note records the primary-source research needed for a production deployment
guide. It is not itself a claim that the Docker or physical Android paths have
been exercised. Repository behavior is cited to the implementation; platform
behavior is cited to current Tailscale, Docker, and Chrome documentation.

## Recommended shape

There are two defensible VPS deployments:

1. **Native Linux plus systemd, using Airlock's `host` mode.** This is the
   lowest-risk production path today because it matches the shipped
   `deploy/airlock.service`, uses the host's normal `tailscaled`, and is the
   mode Airlock defaults to. Tailscale's Linux install remains `curl -fsSL
   https://tailscale.com/install.sh | sh` followed by `sudo tailscale up`, with
   package-specific instructions available if an operator does not want to pipe
   a script into a shell. ([Tailscale: install on Linux](https://tailscale.com/docs/install/linux))
2. **One Airlock container, using Airlock's `embedded` mode.** This is the
   cleanest Docker fit because Airlock already embeds `tsnet`; it needs neither a
   Tailscale sidecar nor `/dev/net/tun`, and it can own a distinct tailnet
   identity from inside an ordinary container. `tsnet` gives a Go program its
   own tailnet IP, DNS name, identity, and HTTPS certificate, and uses a
   userspace TCP/IP stack. ([Tailscale: tsnet](https://tailscale.com/docs/features/tsnet),
   [Tailscale: `tsnet.Server`](https://tailscale.com/docs/reference/tsnet-server-api))

This deployment work adds a multi-stage `Dockerfile`, `compose.yaml`,
`.dockerignore`, and a source-build operator path. The built image and local
token-authenticated HTTP path have been exercised under the intended non-root,
read-only, capability-free container restrictions. A real embedded-tailnet VPS
and Android run remains an explicit hardware acceptance item; no registry image
is claimed or required.

Do not put Tailscale Serve or Funnel in front of Airlock. Airlock is already the
TLS endpoint and derives each caller's identity from the connection's source
address using LocalAPI `WhoIs` ([`tailscale.go`](../tailscale.go#L42-L95),
[`local.Client.WhoIs`](https://pkg.go.dev/tailscale.com/client/local#Client.WhoIs)).
A reverse proxy connects to the backend from loopback, and Airlock deliberately
refuses loopback because it cannot derive a tailnet identity there
([`main.go`](../main.go#L200-L222)). Funnel is public by design, whereas Airlock
requires a tailnet identity for every stateful API.

## What Airlock itself requires

The relevant server contract comes directly from the repository:

- `--auth=tailscale` is the default. `--tailscale-mode=host` uses the machine's
  running daemon; `--tailscale-mode=embedded` creates an in-process `tsnet`
  node. `--hostname` affects embedded mode, and `--port` defaults to 443.
  ([`main.go`](../main.go#L34-L50), [`tailscale.go`](../tailscale.go#L31-L38))
- Embedded mode reads its first-boot credential only from `TS_AUTHKEY` and
  stores Tailscale state under `<data>/tsnet`. It uses `ListenTLS`, so it serves
  HTTPS directly on its private tailnet node. ([`tailscale.go`](../tailscale.go#L97-L128))
- Host mode binds only the host's Tailscale IPv4 and IPv6 addresses, gets and
  renews the certificate through the local daemon, and logs the exact HTTPS URL
  to open. It does not bind the VPS's public or LAN address.
  ([`tailscale.go`](../tailscale.go#L42-L95))
- `--allow-users` is an application-level allowlist of Tailscale login names.
  If omitted, it resolves to the owner of the Airlock server node.
  `--allow-nodes` optionally narrows that to exact Tailscale node names.
  Tagged **caller** nodes are rejected because a tag is a workload identity,
  not a human/device login. ([`tailscale.go`](../tailscale.go#L130-L181))
- `--require-approval` adds Airlock's own per-device admission step. The first
  Airlock client ever recorded is allowed even when this flag is on, so that a
  fresh server cannot deadlock with nobody able to approve it. Subsequent
  devices wait for an allowed device to approve them.
  ([`devices.go`](../devices.go#L66-L105))
- The complete `--data` directory is durable state: it includes the PBKDF salt,
  device registry, transfer records, ciphertext chunks, push keys, and, in
  embedded mode, the `tsnet` node state. The salt is intentionally permanent;
  silently replacing it would make existing sealed state look like a wrong
  passphrase or data loss. ([`main.go`](../main.go#L240-L276),
  [`main.go`](../main.go#L309-L339))

That produces an important bootstrap rule: when `--require-approval` is used,
open Airlock first from a trusted desktop device, set the household passphrase,
and only then open it on the Android device. Otherwise the Android device can
become the automatically admitted first Airlock client.

## Tailnet prerequisites

### MagicDNS and HTTPS

Enable both on the tailnet's **DNS page** in the Tailscale admin console. The
current official procedure is: enable MagicDNS, enable HTTPS Certificates, and
acknowledge certificate-transparency disclosure. The repository README's older
“Settings, Features” wording is version-sensitive and should be updated to the
current DNS-page path. ([Tailscale: enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates))

MagicDNS creates a fully qualified name from the node name and tailnet DNS name,
for example `airlock.yak-bebop.ts.net`. Short machine names work as DNS search
names, but HTTPS certificates do **not** cover a bare name, so users must open
the full URL:

```text
https://airlock.<your-tailnet>.ts.net/
```

Include `:<port>` when Airlock is not on 443. Do not use the `100.x` address:
the certificate is for the fully qualified name and Airlock's TLS callback does
not have a certificate for an IP literal. ([Tailscale: MagicDNS](https://tailscale.com/docs/features/magicdns),
[Tailscale: HTTPS names](https://tailscale.com/docs/how-to/set-up-https-certificates))

Enabling HTTPS has a privacy consequence worth putting beside the switch, not
in fine print: the node's fully qualified name is written to public Certificate
Transparency logs. The IP and access to the node remain private, but the machine
name is public. Choose a neutral name such as `airlock` before requesting the
first certificate. Tailscale/Let's Encrypt certificates last 90 days;
Airlock's use of `local.Client.GetCertificate` or `tsnet.ListenTLS` is the
automatic, in-process path rather than a certificate copied to an arbitrary
filesystem location. ([Tailscale: HTTPS certificates and CT](https://tailscale.com/docs/how-to/set-up-https-certificates))

### Network access policy

New personal tailnets normally start with an allow-all policy. That is
convenient, not least privilege: Tailscale documents that the default policy
lets all tailnet devices communicate. Grants are the current recommended policy
syntax and can restrict a destination to `tcp:443` (or Airlock's selected
port). ([Tailscale: ACL default behavior](https://tailscale.com/docs/features/access-control/acls),
[Tailscale: Grants](https://tailscale.com/docs/features/access-control/grants))

A tagged Airlock server can be restricted like this, merged into the existing
tailnet policy rather than pasted over it:

```jsonc
{
  "tagOwners": {
    "tag:airlock": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["you@example.com"],
      "dst": ["tag:airlock"],
      "ip": ["tcp:443"]
    },
    {
      "src": ["autogroup:member"],
      "dst": ["autogroup:self"],
      "ip": ["*"]
    }
  ]
}
```

The first grant reaches the tagged server. The second is not redundant for
Airlock: direct transfers use WebRTC data channels between the user's client
devices, with no TURN server and no content proxy through the VPS
([`web/peer.js`](../web/peer.js#L362-L367)). Tailscale's official self-access
example uses `autogroup:self` with all IP protocols/ports so one user's devices
can connect to each other. If Airlock permits multiple users and direct transfer
between their devices, replace that self-only rule with a deliberately scoped
group-to-group grant. ([Tailscale: grant examples](https://tailscale.com/docs/reference/examples/grants#allow-users-access-to-their-own-devices))

The JSON above is an example, not a complete universal policy. Use the admin
console's policy preview before saving it and preserve unrelated SSH, subnet,
exit-node, and service rules. Change `tcp:443` when using another port.

### Auth key and tag choices for the server

For an unattended first boot, create a **one-off, non-ephemeral** auth key.
Choose **Pre-approved** if tailnet device approval is enabled. A reusable key is
unnecessary for a single durable server and Tailscale warns that stolen reusable
keys are dangerous. Auth keys expire after 1–90 days, but expiry of the
bootstrap key does not immediately deauthorize a node that already joined; node
key expiry is separate and defaults to 180 days. ([Tailscale: auth keys](https://tailscale.com/docs/features/access-control/auth-keys),
[Tailscale: device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval))

There are two workable identity choices:

- **Untagged one-off key:** the embedded server belongs to the user who created
  the key, so Airlock can infer the default `--allow-users`. For an always-on
  server, explicitly manage or disable that server node's key expiry in the
  Machines page; an expired node key stops all connections.
- **Tagged key (`tag:airlock`):** this is Tailscale's normal model for a server,
  and tagged-node key expiry is disabled by default. Applying a tag removes the
  node's user-based identity, so Airlock must be started with an explicit
  `--allow-users=you@example.com`; otherwise its default “owner of the server
  node” lookup can fail closed. This last requirement is an Airlock-specific
  inference from [`resolveAllowedUsers`](../tailscale.go#L162-L181), combined
  with Tailscale's documented tag semantics. ([Tailscale: tags](https://tailscale.com/docs/features/tags),
  [Tailscale: key expiry](https://tailscale.com/docs/features/access-control/key-expiry))

Do not enroll the Android phone with a tag. Airlock rejects tagged callers, and
Tailscale itself describes tags as identities for non-user workloads rather
than end-user devices.

## Docker-specific findings

### VPS baseline

For an Ubuntu or Debian VPS, follow Docker's distribution-specific **Engine
repository** instructions and install the Compose plugin; do not freeze the
guide around copied package versions or Docker's convenience script, which
Docker recommends only for testing and development. The current Ubuntu package
set is `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, and
`docker-compose-plugin`, verified with `sudo docker run hello-world` and
`docker compose version`. ([Docker: install Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
[Docker: install the Compose plugin](https://docs.docker.com/compose/install/linux/))

Using `sudo docker` for deployment is an acceptable explicit choice. Adding an
administrator to the `docker` group is not an ordinary unprivileged convenience:
Docker documents that membership as root-level access to the host. Also heed
Docker's firewall warning that published container ports can bypass `ufw` or
`firewalld`; Airlock's embedded design avoids that issue by publishing no port.
([Docker: Linux post-install security](https://docs.docker.com/engine/install/linux-postinstall),
[Docker: Ubuntu firewall caveat](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations))

### Best-fit container contract: embedded mode

The supplied Compose service follows this shape:

```yaml
services:
  airlock:
    build: .
    restart: unless-stopped
    command:
      - --tailscale-mode=embedded
      - --hostname=airlock
      - --data=/var/lib/airlock
      - --port=443
      - --allow-users=you@example.com
      - --require-approval
      - --max-total=107374182400
    volumes:
      - airlock-data:/var/lib/airlock
    # Intentionally no `ports:` entry.

volumes:
  airlock-data:
```

The actual [Dockerfile](../Dockerfile) builds against the Go version in
`go.mod`, uses a CA-root-bearing distroless runtime, runs as UID/GID 65532, and
makes only `/var/lib/airlock` plus a small tmpfs writable. `tsnet.ListenTLS` can
listen on 443 without the process being root. ([Tailscale:
`Server.ListenTLS`](https://tailscale.com/docs/reference/tsnet-server-api#server-listentls))

Do not publish `443:443`, `8080:8080`, or any other Docker port. The embedded
listener exists inside the tailnet, not on a conventional container interface,
and publishing a port would add a public/LAN path that Airlock does not need.
Most Tailscale deployments require no inbound firewall opening; outbound TCP
443 and UDP connectivity enable coordination, relays, and direct paths, while
inbound UDP 41641 is only an optional direct-connectivity optimization in some
networks. ([Tailscale: firewall ports](https://tailscale.com/docs/reference/faq/firewall-ports))

Persist the named volume. Docker documents that volumes survive container
replacement and are the preferred store for application-generated durable
data. Tailscale likewise documents that losing container state makes every
restart register a new node. ([Docker: volumes](https://docs.docker.com/engine/storage/volumes/),
[Tailscale: Docker state](https://tailscale.com/docs/features/containers/docker/docker-params#ts_state_dir))

The [operator guide](deployment.md) distinguishes `docker compose down` from
`docker compose down -v`: the latter removes named volumes and would erase the
Airlock salt, registry, queue, and embedded node identity. Take a stopped,
restorable volume snapshot before upgrades rather than relying on an image or
container layer as a backup.

Back up the volume as sensitive data. It contains Airlock's server state and
Tailscale node keys; Tailscale warns that node state contains identity and
traffic cryptographic material and that copying it can clone a node. Never run
the original and a restored copy simultaneously. ([Tailscale: secure node state storage](https://tailscale.com/docs/features/secure-node-state-storage))

### Supplying `TS_AUTHKEY`

Airlock currently accepts `TS_AUTHKEY` only as an environment variable. Docker
correctly recommends file-mounted secrets because environment values can leak
through process inspection or debug logs. ([Docker: Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/))

The choices evaluated were:

1. Add first-class `TS_AUTHKEY_FILE` support to Airlock before presenting
   Compose as production-ready.
2. Use a small image entrypoint that reads `/run/secrets/ts_authkey`, exports it
   only to the Airlock process, and then `exec`s Airlock.
3. Bootstrap once with a one-off key in the environment, confirm
   `/var/lib/airlock/tsnet` persisted, remove the credential from Compose,
   recreate the container, and remove the old container metadata.

The implemented guide chooses option 3 and makes every cleanup and verification
step explicit. The credential exists in the first container's inspectable
configuration only until that container is recreated; a one-off key limits the
consequence of accidental retention. First-class secret-file support remains a
reasonable future hardening.

Do not put a real `tskey-...` in `compose.yaml`, `.env` committed to Git, a
shell-history example, an image layer, or documentation. `tsnet` officially can
display an interactive authentication URL when it has neither an auth key nor
trust credentials, but the repository has not yet exercised that path with
Airlock's blocking `Server.Up` startup. It should be tested before being offered
as the primary headless bootstrap. ([Tailscale: tsnet device authentication](https://tailscale.com/docs/features/tsnet#device-creation-and-authentication),
[`docs/platform-notes.md`](platform-notes.md#not-verified))

### Why the standard Tailscale sidecar recipe does not directly apply

Tailscale's generic Docker pattern shares a Tailscale container's network
namespace with an ordinary web container, or reverse-proxies to a localhost
service. Its official image defaults to userspace networking; kernel mode needs
`/dev/net/tun` plus network capabilities. Persistent `TS_STATE_DIR` is required
to keep the same node identity. ([Tailscale: Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params),
[Tailscale: Docker Compose](https://tailscale.com/docs/features/containers/docker/how-to/connect-docker-container))

Airlock is not an ordinary localhost web service. A Serve/sidecar proxy hides
the peer source address, while Airlock calls `WhoIs(r.RemoteAddr)` and refuses a
loopback peer. A kernel-networked sidecar plus a shared LocalAPI socket and
network namespace may be made to work, but certificate permissions, source
identity, shutdown, and restart behavior have not been integration-tested here.
Do not publish that as the easy path. Embedded mode already solves the same
problem with one process and one persistent volume.

An advanced host-mode container is also theoretically possible on a Linux VPS:
install Tailscale on the host, use Docker host networking, mount the host's
LocalAPI socket, and grant the container process permission to request
certificates. Docker confirms that host networking shares the Linux host's
network namespace and ignores port publishing. This remains untested in this
repository and gives up Docker network isolation; native systemd is simpler.
([Docker: host networking](https://docs.docker.com/engine/network/drivers/host/),
[Tailscale: Linux operator permission](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission))

## Serve and Funnel: explicit distinction

- **Tailscale Serve** exposes a local service only to the tailnet and normally
  terminates HTTPS before reverse-proxying to a local backend. It can also
  forward TCP and optionally use PROXY protocol. ([Tailscale: `tailscale serve`](https://tailscale.com/docs/reference/tailscale-cli/serve))
- **Tailscale Funnel** exposes a service to the public internet. It is limited
  to ports 443, 8443, and 10000, has non-configurable bandwidth limits, and a
  port cannot be Serve-private and Funnel-public at the same time; the most
  recent configuration decides. ([Tailscale: Funnel](https://tailscale.com/docs/features/tailscale-funnel))

Neither should be enabled for Airlock. Serve's proxy path conflicts with
Airlock's source-address `WhoIs` authentication and commonly occupies port 443.
Funnel deliberately removes the tailnet-only boundary, and public callers do
not have the Tailscale user/node identity Airlock requires. If another service
already owns Tailscale port 443, move Airlock to a free port such as 4443 and
put that port in the URL and grant; do not solve the collision by proxying or
making it public.

## Android: tailnet enrollment and Airlock registration

There are two separate enrollments. Complete both; approving one does not
approve the other.

### 1. Add the Android device to Tailscale

1. Install the official Tailscale client from Google Play or Tailscale's
   download page. The current client supports Android 8.0 and later.
2. Open it, select **Get Started**, approve Android's VPN-configuration prompt,
   and allow notifications so the client can warn about reauthentication and
   key expiry.
3. Sign in with the same human identity listed in Airlock's `--allow-users`, or
   another explicitly allowed login. Use normal SSO, not a tagged auth key.
4. If tailnet device approval is enabled, an Owner/Admin/IT admin must approve
   the phone on the admin console's Machines page. An awaiting-approval device
   cannot send or receive tailnet traffic; access starts immediately after
   approval without restarting the phone.
5. Confirm that the Android Tailscale connection is on and that both the phone
   and the Airlock server appear online in Machines.

These steps and UI labels are from Tailscale's current Android and device
approval documentation. ([Tailscale: install on Android](https://tailscale.com/docs/install/android),
[Tailscale: device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval))

### 2. Register and unlock the Android device in Airlock

1. In Android Chrome, while Tailscale is connected, open the full HTTPS URL
   logged by the server, for example
   `https://airlock.yak-bebop.ts.net/`. Do not use the VPS public IP, the
   Tailscale `100.x` IP, `localhost`, or plain HTTP.
2. If the page does not resolve, check that MagicDNS is enabled and that the
   Android client is accepting the tailnet's DNS settings. Clients accept
   Tailscale DNS by default, but this is a per-device preference.
   ([Tailscale: client preferences](https://tailscale.com/docs/features/client/manage-preferences),
   [Tailscale: MagicDNS](https://tailscale.com/docs/features/magicdns))
3. Install Airlock from Chrome's **Install app** or **Add to Home screen** UI,
   then launch that installed icon. Installing first avoids doing setup in a
   browser surface different from the one the user will actually keep. Chrome
   registers an installed PWA with Android launch surfaces, and Airlock's web
   share target becomes available only after installation.
   ([Chrome: installable web apps](https://developer.chrome.com/blog/pwa-install-features),
   [web.dev: Web Share Target](https://web.dev/learn/pwa/os-integration#web_share_target))
4. With `--require-approval`, the phone displays its Tailscale node name and
   waits. On the already trusted Airlock device, open **Devices**, find that
   exact node, and select **Approve**. This is Airlock approval, not the
   Tailscale Machines-page approval from the previous section. The waiting page
   polls and should advance without a reload. ([`web/app.js`](../web/app.js#L452-L476),
   [`web/views/devices.js`](../web/views/devices.js#L78-L123))
5. Enter the same Airlock passphrase used on the first device. The current
   implementation does not transfer a key automatically: “paired” means this
   device successfully acquired the shared key by entering that passphrase.
   ([`web/app.js`](../web/app.js#L64-L107),
   [`README.md`](../README.md#-status))
6. Send a small non-sensitive test file in each direction before trusting the
   deployment. Test both the normal direct mode with both clients awake and
   **Hold on the server if I go offline**. The Android/physical-device acceptance
   path is still explicitly unverified in `docs/platform-notes.md`.

## The four authorization layers

Troubleshooting is easier when these are kept distinct:

| Layer | Where it is managed | What failure looks like |
| --- | --- | --- |
| Tailscale device approval and node-key validity | Tailscale Machines / Device management | The phone or server cannot exchange any tailnet traffic |
| Tailnet grants/ACLs | Tailscale Access controls | DNS may work, but TCP 443 or client-to-client WebRTC traffic is denied |
| Airlock `--allow-users` / `--allow-nodes` | Server command line | The shell may load, but identity-bearing APIs return `not authorized`; a node excluded by `--allow-nodes` cannot appear for in-app approval |
| Airlock `--require-approval` registry | Airlock **Devices** view | The identified device sees the waiting-for-approval screen |
| Airlock shared passphrase | Each browser/PWA's local storage | The device is admitted but cannot unlock/decrypt; a wrong passphrase fails its sealed verifier |

Airlock approval/revocation does not modify the Tailscale Machines list, and
Tailscale approval/revocation does not edit Airlock's registry. A lost unlocked
phone should be revoked in **both** places. Airlock revocation stops future
server calls but cannot make the device forget a passphrase/key or ciphertext it
already copied. There is no in-place key rotation today; a suspected key
compromise requires deliberately starting fresh server state and re-pairing the
remaining devices under a new passphrase.
([`README.md`](../README.md#what-this-does-not-protect-against))

## Production and security checklist

- Keep the VPS's Airlock port unexposed publicly. In embedded Docker mode,
  publish no Docker ports. In host mode, Airlock binds the Tailscale addresses
  itself; a host firewall may need to permit the `tailscale0` interface, but no
  public reverse proxy or DNS record is needed.
- Use a neutral server hostname before enabling its certificate because that
  FQDN enters Certificate Transparency.
- Prefer a one-off, non-ephemeral, pre-approved server auth key. Revoke it after
  successful bootstrap and never reuse it for clients.
- Persist, protect, monitor free space on, and back up the complete data volume.
  Set `--max-total` below real available disk, allowing headroom, and understand
  that `--ttl-hours` removes inactive transfers.
- Never run `docker compose down -v` against the production project unless the
  explicit goal is to destroy its durable Airlock and Tailscale identity state.
- Start with `--require-approval`; bootstrap from the device intended to be the
  first trusted administrator.
- Prefer a tagged server plus a least-privilege TCP grant. When doing that,
  explicitly pass `--allow-users` because the server no longer has a human
  owner identity.
- Preserve a client-to-client grant for Airlock's direct WebRTC path. A grant
  only to the VPS makes the UI reachable but can prevent direct delivery.
- Use a long, unique Airlock passphrase. It protects all current and future
  transfers for the household; server-side device revocation is not key
  rotation.
- Keep Tailscale, the VPS OS, Docker, and the Airlock image updated. Pin image
  digests or release tags in a production Compose file rather than silently
  following `latest`.
- Test restore into an isolated environment. Do not run two restored copies of
  the same embedded `tsnet` state concurrently.

## Version-sensitive or still ambiguous items

These points should be tested and then recorded in the final guide rather than
presented as settled:

1. **The Docker artifact is locally validated, not hardware-validated.** The
   image builds, runs non-root with a read-only root and no capabilities, gates
   its API, and preserves application state across container replacement. The
   embedded node still needs an end-to-end run from a second physical tailnet
   device on the intended VPS.
2. **Interactive embedded login is documented upstream but not tested here.**
   `tsnet` says it displays an authentication URL without credentials; Airlock
   uses blocking `Server.Up`, and the repository's platform notes explicitly
   leave this unchecked.
3. **The current Tailscale admin navigation changed.** Official 2026 docs put
   MagicDNS and HTTPS on the DNS page. Older repository prose says Settings →
   Features. Refer to the linked current docs if the console moves again.
4. **Serve CLI syntax has changed across Tailscale releases.** The current
   reference supports `tailscale serve --https=<port> <target>` and TCP modes,
   but Airlock should not use any of them. Diagnose a conflict with `tailscale
   serve status`; move Airlock's port rather than copying an old Serve recipe.
5. **Tailscale's current generic Docker examples are not internally minimal.**
   The parameter reference says userspace mode is default and kernel mode needs
   `/dev/net/tun` and capabilities, while some quick-start examples add network
   capabilities without explicitly disabling userspace mode. This does not
   affect Airlock embedded mode, which uses its own `tsnet` stack.
6. **A tagged embedded server with explicit `--allow-users` is supported by the
   code path but has not been run on a real tailnet in this repository.** Verify
   startup, certificate issuance, and `WhoIs` before making it the only
   documented production recipe.
7. **Android remains hardware acceptance work.** Verify PWA installation, share
   target registration, notification behavior, background receive, direct
   WebRTC transfer, and a large save on the actual phone/browser versions being
   supported. Record the device, Android version, Chrome version, and Tailscale
   version in `docs/platform-notes.md`.
8. **Strict grants must be tested with the direct path.** TCP access to the VPS
   is insufficient by itself; browser WebRTC host candidates can use dynamic
   client ports. Verify the chosen self/group grant with a real two-device
   transfer before tightening it further.
