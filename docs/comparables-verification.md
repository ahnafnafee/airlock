# Airlock comparables: primary-source verification

Verified 2026-08-16 from official project documentation, websites, and repositories only.

## Bottom line

No project below combines all of Airlock's defining choices: **Tailscale-native device identity, an installable browser client, application-layer ciphertext, a normally direct path, a device-addressed offline queue, and content-defined dedup/delta/resume**.

The closest existing alternatives are:

1. **croc (current v11-era project)** — closest overall feature count. It now has an official browser client, PAKE-based end-to-end encryption, interrupted-transfer resume, self-hostable relay/web infrastructure, and opt-in client-encrypted temporary storage. It lacks Tailscale device identity, an installable PWA, direct tailnet routing, and dedup/delta sync.
2. **Taildrop** — closest user intent and trust boundary: send to another one of *your* Tailscale devices over an encrypted fastest-available path. It lacks Airlock's browser/PWA experience, application-layer sealing, offline store-and-forward, and content-defined chunk/delta system; its file dedup and resume are narrower.
3. **Syncthing** — closest data-plane machinery: persistent paired devices, direct-or-relayed E2E transport, block reuse/delta transfer, partial files, and automatic continuation when peers reconnect. It is continuous folder synchronization, not an ad-hoc transfer inbox or PWA, and has no central ciphertext queue.
4. **PairDrop / LocalSend Web** — closest browser/PWA experience. Both favor live transfers and have no device-addressed offline queue or content-defined dedup/delta layer.

Airlock's direct and server-held paths now both work end to end, including authenticated assembly and export on the receiver. Its important present-tense limitation is device key enrollment: allowlist approval works, but a newly approved device still types the shared master passphrase while the documented ECDH handoff waits on a recovery-model decision ([Airlock README](../README.md#status)).

## Capability matrix

Legend: **Yes** = first-class match; **Partial** = related capability with materially different semantics; **No** = absent or not documented by the cited primary source.

| Project | Tailscale-native identity | Browser / PWA | App-layer E2E | Direct path | Recipient may be offline | Dedup / delta / resume | Self-hostable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Airlock** | **Yes** — `WhoIs()` plus device registry | **PWA** | **Yes** — browser-sealed AES-256-GCM | **Yes**, across the tailnet | **Yes** when server-hold is selected; otherwise locally staged until overlap | Dedup, delta and network-drop resume; full-page preparation resume is deferred | **Yes**, one Go binary |
| **croc** | No — one-time code or capability link | **Web client**, not documented as an installable PWA | **Yes** — PAKE live; AES-256-GCM stored mode | **No for normal internet/web use** — live traffic uses a relay / WebSocket bridge | **Yes**, opt-in encrypted stored mode | No dedup/delta; **resume yes** for CLI live transfers and stored CLI chunks; browser stored downloads do not resume after tab close | **Yes** — relay plus `croc-web` and encrypted store |
| **Taildrop** | **Yes** — personal devices logged into Tailscale | Native clients / CLI, no PWA | Partial — WireGuard E2E at the network layer, not separately sealed file ciphertext | **Yes when Tailscale is direct**, relay fallback otherwise | No server store-and-forward documented | **File dedup** and retry-resume (generally up to one hour, with platform exceptions); no content-defined chunk dedup/delta documented | Partial — part of Tailscale, not a standalone self-hosted transfer service |
| **Syncthing** | No — persistent certificate-fingerprint device IDs | Local web admin GUI, not a file-transfer PWA | **Yes in transit** — mutually identified device TLS; relays see ciphertext | **Yes**, relay fallback | Partial — changes remain on a source peer and sync when peers overlap; no central content queue | **Block reuse/delta and partial-transfer continuation**; not Airlock's global content-defined ciphertext dedup | **Yes**; private relays/discovery may be used |
| **PairDrop** | No — discovery, rooms, or pairing | **PWA** | Partial — WebRTC transport encryption; official FAQ says the signaling server must still be trusted, and WebSocket fallback is server-readable | **Yes via WebRTC**, TURN fallback | No — no database/file storage; peers must be live | No dedup/delta/resume documented | **Yes**, Docker or Node; TURN optional |
| **LocalSend / LocalSend Web** | No — nearby discovery; no accounts | Native apps plus an official **Web PWA** | Partial — HTTPS/WebRTC transport protection, not independently sealed stored payloads | **Yes** — native direct LAN; web uses WebRTC with signaling | No — “offline” means no internet, not an absent receiver | Protocol v2 uploads a whole file body; no dedup/delta/persistent resume documented | **Yes** — native needs no server; web and signaling can be self-hosted |
| **Magic Wormhole / Winden** | No — one-time PAKE code | CLI plus Winden web app; no PWA documented | **Yes** — PAKE-derived encrypted records | Magic Wormhole tries direct TCP then relay; Winden's browser path uses WebSocket relay | No — Winden explicitly requires both ends online | No dedup/delta/resume documented | **Yes** — mailbox, transit relay, and Winden stack are open/self-hostable |
| **Send / PrivateBin family** | No — capability links | Browser apps; installable PWA not central/documented | **Yes** — client-side encryption and server-held ciphertext | No — server upload/download | **Yes** — expiring encrypted server storage | No dedup/delta/resume documented | **Yes** |

## What each one replaces

### croc: closest overall, but a different addressing and routing model

The current croc README explicitly lists relay-based cross-platform transfer, PAKE E2E encryption, browser compatibility, interrupted-transfer resume, and self-hosted relays. Its newer stored mode encrypts names, metadata, and 4 MiB chunks before upload, supports a finite lifetime/download budget, and can be self-hosted. The browser client uses a same-origin WebSocket-to-TCP bridge; normal live transfer is therefore not Airlock's direct tailnet hop. Stored links and live codes are bearer capabilities rather than persistent, authenticated device inboxes. There is chunk resume, but no content-defined dedup or delta sync. Sources: [croc README](https://github.com/schollz/croc), [web client](https://github.com/schollz/croc/blob/main/web/README.md), [stored-transfer design](https://github.com/schollz/croc/blob/main/src/docs/STORED_TRANSFERS.md).

### Taildrop: closest “send to my device” experience

Taildrop sends between a user's personal tailnet devices, uses Tailscale's encrypted fastest-available path, and attempts to resume a retried interruption for up to about an hour (except some Apple receive cases). Tailscale connections upgrade to direct UDP when possible and otherwise use peer-relay or DERP. Tailscale's 1.52 notes also added “file deduplication,” but do not document Airlock-style content-defined chunk reuse or delta sync. This is network-layer E2E and live delivery: the official docs do not describe client-side file sealing or content storage for an offline recipient. Sources: [Taildrop](https://tailscale.com/docs/features/taildrop), [Tailscale 1.52 notes](https://github.com/tailscale/tailscale/wiki/1.52.0), [Tailscale connection types](https://tailscale.com/docs/reference/connection-types), [Tailscale encryption](https://tailscale.com/docs/concepts/tailscale-encryption).

### Syncthing: closest transfer engine, different product

Syncthing authenticates devices by certificate fingerprint, protects device traffic with TLS, normally connects directly, and retains E2E encryption through relays. It compares per-file block lists, fetches only needed blocks, can reuse matching blocks already on disk, and retains partial temporary files. It also naturally waits for peers to overlap online. Those are strong analogues to Airlock's delta/resume path, but Syncthing continuously converges shared folders rather than offering one-shot sends, an inbox, server-held ciphertext, or a browser-installed client. Its documented blocks are size-based, unlike Airlock's content-defined boundaries. Sources: [security principles](https://docs.syncthing.net/users/security.html), [synchronization/block reuse](https://docs.syncthing.net/users/syncing.html), [relay behavior](https://docs.syncthing.net/users/relaying.html), [FAQ](https://docs.syncthing.net/users/faq.html).

### PairDrop and LocalSend: closest UI, live-only semantics

PairDrop is an installable, self-hostable PWA using direct WebRTC, with TURN and optional WebSocket fallbacks. Its FAQ is unusually clear that WebRTC encrypts in transit but the signaling server is not yet zero-trust; the optional WebSocket fallback is readable by the server. It keeps no database or file store, so it cannot queue to an offline peer. Sources: [PairDrop FAQ](https://github.com/schlagmichdoch/PairDrop/blob/master/docs/faq.md), [self-hosting](https://github.com/schlagmichdoch/PairDrop/blob/master/docs/host-your-own.md).

LocalSend's native protocol is direct LAN HTTPS with no account or central server. The newer official web client uses WebRTC/WebSockets, is configured as a PWA, and can be fully self-hosted with its signaling server. Its v2 protocol sends a complete binary file per upload request rather than a content-addressed resumable chunk set. “Offline” in LocalSend's marketing means no internet connection; both endpoints still need to be reachable together. Sources: [LocalSend site](https://localsend.org/), [protocol v2](https://github.com/localsend/protocol), [web client and self-hosting](https://github.com/localsend/web), [PWA configuration](https://github.com/localsend/web/blob/main/nuxt.config.ts).

### Magic Wormhole/Winden and encrypted browser stores

Magic Wormhole establishes a PAKE-authenticated encrypted transfer, tries direct TCP, and falls back to a blind transit relay. Winden brings that model to a browser and is self-hostable, but explicitly transfers in real time with no server storage, so both users must be online; its browser transport goes through the WebSocket relay. Sources: [Magic Wormhole protocol](https://magic-wormhole.readthedocs.io/en/latest/file-transfer-protocol.html), [transit protocol](https://magic-wormhole.readthedocs.io/en/latest/transit.html), [Winden](https://github.com/LeastAuthority/winden).

Self-hosted browser projects such as the maintained [Send fork](https://github.com/timvisee/send) and [PrivateBin](https://github.com/PrivateBin/PrivateBin) cover the opposite half: client-encrypted, expiring server storage behind a capability link. They do not provide authenticated personal-device routing, a direct path, or Airlock's dedup/delta/resume machinery.

## Practical conclusion

If the goal is simply **move a file between my Tailscale devices now**, use Taildrop. If the goal is **persistent, efficient replication**, use Syncthing. If the goal is **zero-install live browser transfer**, use PairDrop or LocalSend Web. If the goal is **E2E live transfer plus optional asynchronous encrypted storage**, current croc is already very close.

Airlock remains differentiated only if the combined experience matters: a persistent inbox addressed to authenticated tailnet devices, PWA/OS integration, direct tailnet delivery by default, optional zero-knowledge store-and-forward, and content-defined dedup/delta/resume in one self-hosted service.
