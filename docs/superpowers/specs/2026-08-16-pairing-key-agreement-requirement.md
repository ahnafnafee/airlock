# Requirement: adding a device must not mean typing the master passphrase

Status: **requirement only. Nothing here is implemented.**
Raised: 2026-08-16, prompted by comparison with [croc](https://github.com/schollz/croc).

## The problem

Airlock derives one long-lived master key from a passphrase that every device
types:

```
MK = PBKDF2-SHA256(passphrase, salt, 600000 iterations)
```

`web/crypto.js` holds the derivation and the iteration count. 600,000 is the
current OWASP figure for PBKDF2-HMAC-SHA256, so the parameters are not the
complaint. The shape is.

Two consequences follow from it, and both get worse as more devices are added.

**A verifier sits on the server, and it is offline-crackable.** `check.bin` is
sealed under MK so a second device can tell a right passphrase from a wrong one.
That is also an oracle: anyone holding the data directory can attempt passphrase
guesses offline at their own pace, with no server and no rate limit. PBKDF2 at
600k iterations is then the only thing between a stolen data directory and every
sealed chunk in it. The whole point of sealing client-side is that a compromised
server learns nothing, and this is the one artifact that weakens that claim.

**The passphrase has to be typed on a phone.** It must be long, because it is
the input to the only slow function in the system, and every new device has to
enter it exactly. That pushes people toward short passphrases, which is the
failure the first consequence punishes hardest.

## What is required

**MUST.** Adding a device to an existing Airlock server must not require typing
the master passphrase on the new device.

**MUST.** The server must not hold any artifact that permits an offline guessing
attack against a human-chosen secret. If a verifier is still needed, it must be
verifiable only through an online, rate-limited, authenticated exchange.

**MUST.** A person watching both screens must be able to confirm that the two
devices agreed on the same key, without trusting the server to have relayed
honestly. The confirmation must be short enough to read aloud.

**SHOULD.** The new device should reach a usable state in one short interaction:
read a code, type or compare it, done.

**SHOULD.** The existing device stays the authority. Pairing must remain an
explicit act of approval on a device that already holds the key, not something a
new device can complete alone.

**MAY.** The passphrase may remain as a recovery path for the case where every
paired device is lost. If it does, see the open question below, because that
path reintroduces exactly the artifact the second MUST removes.

**MUST NOT.** No new runtime dependency may be added to satisfy this without an
explicit decision. See the constraint below, which is the whole difficulty.

## Why croc is the reference

croc solves the neighboring problem: two parties with no prior relationship, and
a short code phrase that must nevertheless produce a strong key. It uses
password-authenticated key agreement, where a low-entropy secret is safe because
the protocol yields nothing an attacker can test offline. Guessing costs one
online attempt each time.

That property is the one Airlock wants. The rest of croc's design is not
applicable and should not be copied:

- Its relay exists because its two parties may not be able to reach each other.
  Airlock deliberately has no relay, and its parties are on one tailnet.
- Its per-transfer code phrase exists because there is no prior relationship.
  Airlock has a tailnet identity plus a device allowlist, which is stronger and
  already implemented.

One thing to keep rather than adopt: croc's CVE-2023-43621 leaked the shared
secret through the process name on Linux and macOS. Airlock reads its token from
`AIRLOCK_TOKEN` in the environment and has no `--token` flag. That is the right
side of that bug and must stay that way.

## The constraint that decides the design

**WebCrypto has no PAKE, and it cannot be built on top of WebCrypto.** SPAKE2,
CPace and OPAQUE all need arithmetic on group elements: hashing to a curve,
adding points, multiplying by a scalar the caller chooses. WebCrypto exposes
ECDH as a sealed operation and no point arithmetic at all. Implementing a PAKE in
the browser therefore means shipping an elliptic-curve library, in JavaScript or
as WebAssembly, and hand-rolling one is how PAKE implementations get broken.

So the requirement above can be met in two ways, and they are not equally
priced.

### Option A: a real PAKE

Ship an audited implementation, most likely CPace or OPAQUE compiled to
WebAssembly. Highest assurance, and the only option that keeps a memorable
passphrase safe as the primary secret. Costs a dependency, a WASM payload in a
binary that currently embeds nothing but its own source, and a review burden on
the exact component whose failure is silent.

### Option B: ECDH plus a short authentication string

The observation that makes this cheap: **Airlock already has an authenticated
channel that croc does not.** Tailscale proves both devices belong to the same
tailnet user, and pairing already requires an explicit approval on a device that
holds the key. What is missing is only a way to move the key across that channel
without the server reading it.

```
new device     generates an ephemeral ECDH keypair          (WebCrypto, P-256)
               publishes its public key
existing dev   generates its own ephemeral keypair
               derives a shared secret by ECDH
both           show SAS = first 6 digits of HKDF(shared secret, "airlock-sas")
person         confirms the two screens show the same number
existing dev   wraps MK under a key derived from the shared secret
new device     unwraps MK
```

Every primitive here is native WebCrypto: `generateKey` for P-256 ECDH,
`deriveBits`, HKDF, AES-GCM. No dependency, no WASM, no hand-rolled curve code.

The short authentication string is what defeats a server that substitutes its own
public keys, which is the one attack an untrusted relay can mount. A
man-in-the-middle would have to produce a shared secret whose first six digits
match a number it cannot influence, which it can do with probability one in a
million per attempt, on an exchange a person is watching.

This is the numeric-comparison pairing model, the same shape as Bluetooth Secure
Simple Pairing and Signal's safety numbers. It is well understood, and it fits
what Airlock already has.

**Option B is the recommendation** unless the passphrase must survive as the
primary secret, in which case only Option A will do.

## The open question, which must be answered before either is built

If devices no longer type a passphrase, what is the master key derived from, and
what happens when every paired device is lost?

- **A random master key** minted by the first device removes the passphrase
  entirely: nothing to guess, no verifier, nothing to store on the server, and
  the second MUST above is satisfied outright. The cost is that losing every
  device loses every sealed transfer permanently, with no recovery path.
- **Keeping the passphrase as a recovery path** reintroduces a verifier, and with
  it the offline attack, unless the recovery path is deliberately made online and
  rate limited.
- **An exported recovery file**, written once and kept by the owner, sits between
  the two: no server-side artifact, and recovery is possible for anyone who kept
  the file.

This is a product decision about what "I lost my phone and my laptop" should
mean, not a cryptographic one, and it should be made before any code is written.

## What must not change

- Sealing stays client-side. The server continues to hold ciphertext it cannot
  read, and pairing must not become a reason to hand it anything more.
- Convergent chunk ids stay as they are. This requirement concerns how the master
  key reaches a device, not how content is addressed.
- The existing approve-and-revoke device registry stays. Key agreement is a step
  inside pairing, not a replacement for the allowlist.
