# Prior art: comparable projects to Airlock

Research date: 2026-08-16. All claims below were checked against primary sources (official documentation, project repositories, or vendor sites); the source URL is cited inline or per section. Where a fact could not be confirmed from a primary source, that is stated explicitly.

Airlock's claimed differentiators, for comparison:

- File transfer between a user's **own devices**, self-hosted, built explicitly on **Tailscale** (server is a tailnet node; auth = Tailscale WhoIs; MagicDNS + ts.net TLS; no public port).
- **Browser PWA** client; content-defined chunking; **AES-256-GCM convergent encryption sealed in the browser** with a passphrase-derived master key that never leaves devices; dedup, delta sync, resume-after-reload.
- Server is a **queue/presence/signalling node** holding only ciphertext metadata; data moves **direct device-to-device over the tailnet**; resumable across disjoint online windows via progress bitmaps; opt-in per-transfer ciphertext spool.
- **One Go binary, no database**; PWA with push notifications, share targets, service-worker decrypt-on-download.

---

## 1. Tailscale Taildrop

**What it is.** Taildrop is Tailscale's built-in file transfer feature: it "lets you send files between your personal devices on a Tailscale network (known as a tailnet)", with transfers going "over encrypted peer-to-peer connections, using the fastest available path". ([Tailscale docs](https://tailscale.com/kb/1106/taildrop))

**How it works.** Technically it is "just an unauthenticated file transfer layer on top of Tailscale". An HTTP PUT from sender to receiver over Tailscale's peerapi, with no extra auth/crypto layer because "Tailscale is already authenticated" and WireGuard-encrypted end-to-end. Transfers "go point to point rather than through the cloud"; "It never stores your files in the cloud or sends them to us." ([Tailscale blog, "Taildrop was kind of easy, actually"](https://tailscale.com/blog/2021-06-taildrop-was-easy))

**Requirements, client support, queueing.**

- "Taildrop also requires both devices to be running Tailscale." Senders: macOS/iOS/Windows/Android via OS share menus; Linux send/receive is CLI-only (`tailscale file cp` / `sudo tailscale file get`). ([docs](https://tailscale.com/kb/1106/taildrop))
- Only between your own devices: "You cannot send files to devices owned by other users." ([docs](https://tailscale.com/kb/1106/taildrop))
- No persistent queue: the docs describe no offline delivery or store-and-forward. Only that "In most cases, a transfer can be resumed for up to an hour after it failed" and "Taildrop can resume transfers on all platforms except when a macOS or iOS device is receiving the file." ([docs](https://tailscale.com/docs/features/taildrop)) The docs page does not document offline-recipient behavior at all; the blog confirms files are never stored server-side.
- Must be enabled per tailnet in the admin console ("Send Files" opt-in, alpha feature). ([docs](https://tailscale.com/kb/1106/taildrop))

**Overlap with Airlock:** own-devices-only transfer over a tailnet, direct peer-to-peer data path, no server-side content storage, resume of interrupted transfers. This is the same problem domain and the same "just ride the tailnet" architecture.

**Key differences:** no browser/PWA client (native apps only; Linux is CLI-only and receive needs root); no app-layer encryption beyond WireGuard transport; no chunk-level dedup or delta sync; no resumption across disjoint online windows (1-hour resume window only, and not on macOS/iOS receivers); the feature itself cannot be self-hosted independently. It ships inside the (closed-server) Tailscale control plane, with `tailscaled` on every device.

---

## 2. Syncthing

**What it is.** Syncthing is "a continuous file synchronization program" that syncs directories between devices in real time. "Every device is identified by a strong cryptographic certificate", and only devices explicitly allowed can connect; "All communication is secured using TLS". ([syncthing.net](https://syncthing.net/))

**Delta sync and dedup.** Files are "divided into blocks" (128 KiB-16 MiB by size), each hashed (SHA-256); updates fetch only blocks whose hashes differ, and a needed block "might be [available] locally, if another file already has a block with the same hash" (local block deduplication). ([docs: syncing](https://docs.syncthing.net/users/syncing.html))

**Relays/discovery.** "Syncthing can bounce traffic via a relay when it's not possible to establish a direct connection between two devices"; "The connection between two devices is still end to end encrypted, the relay only retransmits the encrypted data"; "Relaying is enabled by default but will only be used if two devices are unable to communicate directly." Community/global discovery servers and relay pools exist and can be self-hosted. ([docs: relaying](https://docs.syncthing.net/users/relaying.html))

**Browser client?** The browser UI is for administration: "Configure and monitor Syncthing via a responsive and powerful interface accessible via your browser". Synchronization itself requires a native daemon on each device. ([syncthing.net](https://syncthing.net/))

**Overlap with Airlock:** device-to-device direct transfer, E2E-encrypted even through relays, block-based delta sync, block dedup, resumability, self-hostable infrastructure, open source.

**Key differences:** continuous folder synchronization model (not ad-hoc send/queue between devices); identity/trust via per-device certificates and device IDs (not a shared passphrase-derived key); TLS transport encryption only. No encryption-at-rest of synced folders and no convergent encryption; no browser client (native daemon + admin web UI); sync does not cross "disjoint online windows" by design. Folders converge whenever peers happen to be online; database + daemon per node, not a single queue/signalling binary; not built on Tailscale (though it runs fine over it).

---

## 3. magic-wormhole and its ports / web frontends

**What it is.** magic-wormhole is a Python "library and a command-line tool named wormhole" that "makes it possible to get arbitrary-sized files and directories (or short pieces of text) from one computer to another", paired via short single-use "wormhole codes" (PAKE-derived session key). It depends on two server components, "the mailbox server, and the transit relay", both open source and self-hostable. ([GitHub: magic-wormhole/magic-wormhole](https://github.com/magic-wormhole/magic-wormhole)) The README does not spell out the relay's data visibility, but the protocol's transit relay carries only PAKE-encrypted traffic (see the project docs site, below).

**Ports and frontends. What is real and maintained** (per the project's own ecosystem page, [magic-wormhole.readthedocs.io/ecosystem](https://magic-wormhole.readthedocs.io/en/latest/ecosystem.html)):

- **wormhole-william**. Real: "a Go library and CLI for file-transfer" (Core Full, File v1 Full; no Dilation). Repo: [psanford/wormhole-william](https://github.com/psanford/wormhole-william) (1,245 stars; last push 2025-08-05 per GitHub API. Active-ish but not fast-moving).
- **Winden**. Real: "a Web client and deployment (using the Go implementation via WASM)" at [winden.app](https://winden.app) (currently labelled 0.5.4-beta); repo [leastauthority/winden](https://github.com/leastauthority/winden) (last push 2026-07-09 per GitHub API. Maintained).
- **magic-wormhole.rs, Warp (GNOME GUI), Destiny (mobile), Rymdport, etc.**. Also catalogued on the ecosystem page; the Python reference implementation remains the most complete ("Dilation … is still in development").

**wormhole.app is a different product.** Despite the name, wormhole.app is not a magic-wormhole frontend. Per its own FAQ: "For files up to 5 GB, Wormhole stores your files on our servers for 24 hours"; larger files go peer-to-peer "directly from your browser to the recipient" while the sender keeps the tab open; files are encrypted client-side with "128-bit AES-GCM … before they leave the browser". ([wormhole.app/faq](https://wormhole.app/faq)) It is a hosted, proprietary service, not self-hostable.

**Overlap with Airlock:** E2E-encrypted ad-hoc transfer, self-hostable coordination/relay servers, a genuine browser client exists (Winden), resumability is limited (Python CLI has some reconnect support; the ecosystem table rates Reconnect "Full" only for Python).

**Key differences:** one-shot human-transcribed codes as the trust root (not persistent device identity or a passphrase-derived key); both parties must be online simultaneously (no queue across disjoint windows, no server-side spool by default); transit relay moves all bytes when P2P fails; no chunk dedup or convergent encryption; no Tailscale integration.

---

## 4. croc

**What it is.** croc is a CLI tool that "allows any two computers to simply and securely transfer files and folders", using "password-authenticated key agreement (PAKE) … to generate a secret key for the sender and recipient to use for end-to-end encryption". Data flows via relay servers; "No need for local server or port-forwarding". The relay is self-hostable (`croc relay`, or `croc --relay myrelay.example.com:9009 send …`). It "allows resuming transfers that are interrupted", and has an opt-in `croc send --store` mode that uploads "client-side encrypted ciphertext" with an expiring link for later download. ([GitHub: schollz/croc](https://github.com/schollz/croc))

**Overlap with Airlock:** E2E encryption via PAKE, self-hostable relay, resume of interrupted transfers, opt-in ciphertext-hold mode, cross-platform.

**Key differences:** CLI-first (there is a browser receiver at getcroc.com; the browser is a receiver, not the primary client); one-shot code phrases as trust root; both parties online for live transfers (unless using `--store`, which uploads ciphertext to the relay); relay carries all traffic rather than direct device-to-device; no dedup/delta/chunk convergent encryption; not built on Tailscale.

---

## 5. Firefox Send successors: timvisee/send (and wormhole.app-style services)

**Context.** Mozilla discontinued Firefox Send in 2020; Tailscale's own engineering blog (primary-adjacent) recounts that Send was "costly" and "a magnet for botnets and abuse" ([tailscale.com/blog](https://tailscale.com/blog/2021-06-taildrop-was-easy)); the timvisee/send README confirms "Mozilla discontinued Send, this fork is a community effort to keep the project alive."

**timvisee/send.** "A fork of Mozilla's Firefox Send". "a file sharing experiment which allows you to send encrypted files to other users" via expiring links, encrypted client-side in the browser; "Mozilla & Firefox branding is removed so you can legally self-host"; Docker/AWS deployment supported; compatible with the `ffsend` CLI. ([GitHub: timvisee/send](https://github.com/timvisee/send)) Maintenance: not archived, but the repository was last pushed 2025-07-01 (GitHub API, checked 2026-08-16) and pins Node.js 16. Effectively dormant.

**Overlap with Airlock:** browser-side encryption before upload, self-hostable, link/recipient model, single-purpose web app.

**Key differences:** the server stores the (encrypted) file content and serves downloads. It is a store-and-forward service, not device-to-device; link-based sharing with anyone, not own-devices identity; expiry/download caps rather than resumable queues; no dedup, no delta sync, no direct transfer; maintenance of the main fork has stagnated (a pattern repeated below).

---

## 6. LocalSend

**What it is.** LocalSend is an "open-source cross-platform alternative to AirDrop" (Apache-2.0); "LocalSend doesn't require an internet connection or third-party servers"; devices talk over the LAN with "All data … sent securely over HTTPS, and the TLS/SSL certificate is generated on the fly on each device". Native apps for Android, iOS, macOS, Windows, Linux. ([GitHub: localsend/localsend](https://github.com/localsend/localsend))

**Overlap with Airlock:** same "AirDrop for my own devices" use case; direct device-to-device transfer; no cloud; open source.

**Key differences:** local network only. Useless across networks (the opposite of a tailnet); native apps rather than a browser PWA; TLS between peers with self-signed certs, no at-rest encryption layer, no passphrase/key identity model; no chunking/dedup/delta or documented resume; discovery via multicast, not an identity-aware queue server.

---

## 7. PairDrop / Snapdrop

**What they are.** Snapdrop is "local file sharing in your browser", inspired by Apple's AirDrop. A PWA using WebRTC/WebSockets with a Node.js backend for signaling. ([GitHub: RobinLinus/snapdrop](https://github.com/RobinLinus/snapdrop)) Its README announces "Snapdrop has been acquired by LimeWire"; the repo "will stay as-is" for self-hosting. Last push 2025-02-10 (GitHub API), i.e., no longer actively developed. PairDrop is an actively maintained "Fork of Snapdrop": devices on the same network pair via WebRTC, but it also supports "temporary public rooms to transfer files easily over the Internet", "Persistent Device Pairing" (6-digit code/QR) so paired devices "always find each other via shared secrets independently of their local network", TURN fallback for NAT, and self-hosting "with Docker or Node.js". ([GitHub: schlagmichdoch/PairDrop](https://github.com/schlagmichdoch/PairDrop))

**Overlap with Airlock:** browser PWA, signalling server that never touches file content (WebRTC data flows peer-to-peer), self-hostable, works both LAN and cross-network, device-pairing concept.

**Key differences:** trust root is a session code/room or pairing secret, not per-user keys or tailnet identity; WebRTC DTLS encryption is transport-level and unauthenticated against the signalling server (server mediates who talks to whom); both devices must be online simultaneously. No queueing or resumption across disjoint windows; no dedup/delta; general public rooms have no E2E identity binding at all.

---

## 8. OnionShare

**What it is.** "OnionShare is an open source tool that lets you securely and anonymously share files, host websites, and chat with friends using the Tor network". It runs Tor onion services on the sender's machine; recipients connect with Tor Browser. ([GitHub: onionshare/onionshare](https://github.com/onionshare/onionshare))

**Overlap with Airlock:** open source, direct connection between the two parties (sender hosts, receiver downloads), no third-party content server, self-run.

**Key differences:** sender-hosted model. The sharer's machine must be online and running the service for the whole download; anonymity via Tor rather than authenticated own-device identity; no browser-side app-layer E2E crypto layer beyond Tor's onion encryption; native desktop app; no dedup/delta/queue; performance and recipient friction (Tor Browser) are significant.

---

## 9. Resilio Sync (proprietary, contrast)

**What it is.** Resilio Sync is "Personal file sync and share powered by P2P" that "automatically syncs files between computers via secure, distributed technology", with "Selective Sync" placeholders and bandwidth controls; the vendor now distributes all former Pro features in the free download, and Resilio has been acquired by Nasuni. ([resilio.com/sync](https://www.resilio.com/sync/)) The site offers binary downloads only; no source code is published (closed source. Observable from the site itself, which links only installers and a license).

**Overlap with Airlock:** P2P sync between one's own devices, selective sync, delta-style efficiency claims.

**Key differences:** proprietary/closed-source (unverifiable crypto and handling); native clients only; continuous folder sync rather than ad-hoc queue-based transfer; no browser client; identity via sync secrets/keys managed by the app; no self-hosting story at all.

---

## 10. Purpose-built file transfer ON Tailscale (closest-overlap search)

Searches run (GitHub repo search + official awesome list, 2026-08-16): "tailscale file transfer", "taildrop", "tailnet file", "tailscale web drop", "tailscale share files self-hosted", "tailscale self-hosted file sharing", "tailscale airdrop", and a star-ranked sweep of all repos mentioning "tailnet".

**Findings:**

- The official community list [tailscale-dev/awesome-tailscale](https://github.com/tailscale-dev/awesome-tailscale) contains **no file-transfer/file-sharing apps**. The nearest entries are tclip ("A paste bin for your tailnet") and golink (shortlinks).
- The "taildrop" search results are overwhelmingly **integrations and wrappers around the built-in Taildrop CLI**, not independent transfer systems: e.g. [nautilus-taildrop](https://github.com/bahorn/nautilus-taildrop), [Dolphin-Taildrop-Plugin](https://github.com/Stalloevan/Dolphin-Taildrop-Plugin), [tail-up](https://github.com/mateoalfaro/tail-up) ("native Linux Taildrop client"), [send-with-taildrop](https://github.com/idobaruch7/send-with-taildrop). None add a browser client, E2E-at-rest crypto, or queueing.
- Two small projects do occupy the same *deployment niche* (self-hosted, tailnet-only web drop for own devices), but both hold plaintext content server-side:
  - [kamil77890/taildrop](https://github.com/kamil77890/taildrop) (0 stars, updated 2026-08-02): "Private, Tailscale-only file & message sharing between your own devices … Runs entirely on your own hardware, bound to your tailnet (100.x.x.x), never exposed to the public internet." FastAPI + React + SQLite; uploads live in a server-side `uploads/` directory with generated thumbnails. The server has plaintext, authentication is Argon2 password + session cookies, not E2E encryption. No direct device-to-device path, no dedup/delta.
  - [SproutSeeds/dumpy](https://github.com/SproutSeeds/dumpy) (0 stars, updated 2026-05-06): "A tiny file, link, and text drop for a Tailscale tailnet", npm-installable Node service served via ts.net. Files are stored in a server-side data directory with in-app previews ("File cards include download and in-app preview actions"). Again a server-content model, not E2E, not P2P.
- No project found that combines Tailscale-native identity/auth (WhoIs), a browser PWA, app-layer E2E encryption in the browser, and direct device-to-device movement with a content-free queue/signalling server. The closest conceptual neighbours in the wider tailnet ecosystem are communication tools such as [cylonix/tailchat](https://github.com/cylonix/tailchat) ("server-less instant messaging app on tailnet"). Messaging, not file transfer.

---

## 11. Adjacent projects surfaced by general searches

Catches from "self-hosted end-to-end encrypted file transfer own devices" and "p2p file transfer web app self-hosted" (verified at their own sites/repos):

- **Hoodik**: "a lightweight, self-hosted, end-to-end encrypted cloud storage server"; "All encryption and decryption happens in your browser", so the server never sees plaintext; files "split into encrypted chunks for concurrent upload/download"; keys are random per file (AEGIS-128L, X25519+ML-KEM-768 wrapping), which rules out convergent dedup; Rust + Vue; CC BY-NC 4.0 (non-commercial). Server-stores-ciphertext drive model with link sharing. Not device-to-device. ([GitHub: hudikhq/hoodik](https://github.com/hudikhq/hoodik))
- **YeetFile**. "a privacy-focused encrypted file sending service and file/password vault"; "All content is encrypted locally, and the server is incapable of decrypting any transmitted content"; link-based sharing with expiry/download caps; self-hostable (Docker); AGPL-3.0. The repo was **archived by the owner on Apr 7, 2026** (read-only). Another Send-style project going dormant. ([GitHub: benbusby/yeetfile](https://github.com/benbusby/yeetfile))
- **SkySend**. Self-described: "Self-hostable, end-to-end encrypted file and note sharing"; "the server only ever stores ciphertext and never sees the key" (key in URL fragment); filesystem/S3 storage; AGPL-3.0. Again a store-and-forward link model, not direct transfer. ([skysend.app](https://skysend.app/))
- A self-hosted **P2P file-transfer + messaging PWA** showcase on the Privacy Guides forum ([thread](https://discuss.privacyguides.net/t/selfhosted-p2p-file-transfer-messaging-pwa/24306)) points at positive-intentions' chat app (P2P encrypted, no registration, PWA); it is a messaging app with security concerns raised by third parties, offline messaging "in research phase", and no Tailscale/own-device-queue model.

---

## Summary comparison

| Project | Own-devices model | Client | App-layer E2E / keys | Data path | Offline queue / resume | Dedup / delta | Self-host | Built on Tailscale |
|---|---|---|---|---|---|---|---|---|
| Taildrop | Yes (own devices only) | Native apps; Linux CLI | WireGuard transport only (no app-layer seal) | Direct peer-to-peer | No persistent queue; resume ≤1h, not macOS/iOS receivers | No / no | Feature ships with Tailscale itself | Yes (is Tailscale) |
| Syncthing | Peer sync (folder model) | Native daemon + web admin UI | TLS transport; device certs | Direct, relay fallback (E2E through relay) | Converges when both online; no queue server | Block dedup + block delta | Yes | No |
| magic-wormhole / Winden | Ad-hoc two parties | CLI (+ Winden web beta) | PAKE code → session key | Direct then transit relay | No queue; limited reconnect | No / no | Yes (mailbox+relay) | No |
| croc | Ad-hoc two parties | CLI (browser receiver) | PAKE code phrase | Relay (all traffic) | Resume yes; opt-in ciphertext `--store` | No / no | Yes (relay) | No |
| timvisee/send | Link to anyone | Browser | Client-side key in link | Sender → server → recipient | Expiring links; no resume | No / no | Yes (Node+Redis+S3) | No |
| LocalSend | Nearby devices | Native apps | TLS self-signed per device | LAN direct | No | No / no | n/a (app is the server) | No |
| PairDrop / Snapdrop | Same-room/room-code pairing | Browser PWA | WebRTC DTLS (transport) | WebRTC P2P (TURN fallback) | Both online; no queue/resume | No / no | Yes | No |
| OnionShare | Sender-hosted share | Native app + Tor Browser | Tor onion encryption | Tor onion service (sender hosts) | Sender must stay online | No / no | n/a (app) | No |
| Resilio Sync | Peer sync | Native apps (closed) | Proprietary | P2P | Continuous sync | Selective sync; delta (claimed) | No | No |
| kamil77890/taildrop | Own devices on tailnet | Web (React) | None. Server holds plaintext | Device → server → device | Server-side storage | No / no | Yes (FastAPI+SQLite) | Yes (tailnet-only binding) |
| SproutSeeds/dumpy | Own devices on tailnet | Web | None. Server holds plaintext | Device → server → device | Server-side cards, 30-day trash | No / no | Yes (npm Node) | Yes (ts.net) |
| Hoodik / YeetFile / SkySend | Link/drive model | Browser (+ mobile) | Yes, client-side keys in link | Browser → server (ciphertext) → browser | Expiring links | No convergent dedup (random keys) | Yes | No |

---

## Conclusion

**Closest comparables, ranked by overall overlap:**

1. **Tailscale Taildrop**. The only mainstream tool that already delivers "send files between my own devices, over my tailnet, directly, with nothing stored server-side." It matches Airlock's deployment philosophy almost exactly (so much so that Tailscale's blog makes the same Firefox-Send-vs-tailnet argument Airlock's design implies). It lacks: any browser client, app-layer encryption, dedup/delta, resumption across disjoint online windows, and independence from the Tailscale control plane (it cannot be self-hosted; Linux receive is root CLI).
2. **Syncthing**. The only comparable with real chunk-level delta sync, dedup, and E2E-through-relay transport. But it is a continuous folder-sync daemon (device IDs, per-node database), not an ad-hoc transfer queue, and has no browser client.
3. **PairDrop (and Winden)**. The closest in *client shape*: self-hostable signalling server + browser PWA + peer-to-peer data. But trust is a room/pairing code, both parties must be online at once, and there is no chunking, dedup, or resume.
4. **timvisee/send, YeetFile, SkySend, Hoodik**. The self-hosted E2E-browser-crypto family. All are store-and-forward: the server holds ciphertext and serves it later. This gets offline delivery, but gives up the direct device-to-device path, and the category has a demonstrated maintenance-mortality problem (Mozilla shutdown, archived YeetFile, dormant timvisee fork).
5. **kamil77890/taildrop and SproutSeeds/dumpy**. The only purpose-built "file drop for a tailnet" apps found; same niche and same Tailscale-only deployment, but both are plaintext server-content stores (0 stars, personal projects).

**The gap Airlock would occupy:** no found project combines (a) Tailscale-native identity/auth and networking (WhoIs, tailnet node, no public port) with (b) a browser PWA client that seals data app-layer-E2E with a passphrase-derived key held only on devices, (c) direct device-to-device data movement with a content-free queue/presence server, and (d) chunk-level dedup/delta/resume across disjoint online windows, in one self-hosted Go binary. Each comparable covers a strict subset: Taildrop covers (a)+(c-partial), Syncthing covers (d)+(c) without (a)/(b), PairDrop/Winden cover (b-partial)+(c) without (a)/(d), and the Send-successors cover (b) without (c)/(d). One neutral observation: the convergent (deduplicating) encryption Airlock uses is a design choice absent from every comparable. Syncthing does not encrypt at rest at all, and the E2E storage projects (Hoodik et al.) deliberately use random per-file keys, which precludes dedup; convergent encryption is usually described as carrying a content-guessability trade-off, where an attacker who guesses a plaintext can confirm it by deriving its identifier and looking for a match. Airlock does not accept that trade-off. `chunkIdentity` in `web/crypto.js` derives `cid = HKDF(MK, salt = SHA-256(plaintext), info = "airlock-cid-v1")`, so the master key is mixed into the identifier and nobody without it can compute a cid from a guessed plaintext. Dedup therefore works within one master key, which is one household, and confirmation across servers or across users is closed. The remaining exposure is the ordinary one: a device that already holds the master key can test guesses, and that device could read the files anyway.

---

## Sources (primary)

- Tailscale Taildrop docs: <https://tailscale.com/kb/1106/taildrop>, <https://tailscale.com/docs/features/taildrop>
- Tailscale blog "Taildrop was kind of easy, actually": <https://tailscale.com/blog/2021-06-taildrop-was-easy>; "Sending Files with Taildrop": <https://tailscale.com/blog/sending-files-with-taildrop>
- Syncthing homepage/docs: <https://syncthing.net/>, <https://docs.syncthing.net/users/syncing.html>, <https://docs.syncthing.net/users/relaying.html>
- magic-wormhole repo: <https://github.com/magic-wormhole/magic-wormhole>; ecosystem page: <https://magic-wormhole.readthedocs.io/en/latest/ecosystem.html>; wormhole-william: <https://github.com/psanford/wormhole-william>; Winden: <https://winden.app>, <https://github.com/leastauthority/winden>; wormhole.app FAQ: <https://wormhole.app/faq>
- croc repo: <https://github.com/schollz/croc>
- timvisee/send repo: <https://github.com/timvisee/send> (maintenance via GitHub API `pushed_at` 2025-07-01, checked 2026-08-16)
- LocalSend repo: <https://github.com/localsend/localsend>
- Snapdrop repo: <https://github.com/RobinLinus/snapdrop>; PairDrop repo: <https://github.com/schlagmichdoch/PairDrop>
- OnionShare repo: <https://github.com/onionshare/onionshare>
- Resilio Sync: <https://www.resilio.com/sync/>
- awesome-tailscale: <https://github.com/tailscale-dev/awesome-tailscale>
- Tailnet-native projects: <https://github.com/kamil77890/taildrop>, <https://github.com/SproutSeeds/dumpy>, <https://github.com/cylonix/tailchat>
- Adjacent E2E storage/sharing: <https://github.com/hudikhq/hoodik>, <https://github.com/benbusby/yeetfile>, <https://skysend.app/>, <https://discuss.privacyguides.net/t/selfhosted-p2p-file-transfer-messaging-pwa/24306>
