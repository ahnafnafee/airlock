import { registerView, state, el, onInbox, notifyStatus, pushCapable, enableNotifications, toast } from '../app.js';
import { api } from '../api.js';
import { renderStrip } from '../strip.js';
import { RUNG, exportFile } from '../export.js';
import { DOMAIN, MODE_SEALED, openRecord, modeOf, b64decode } from '../crypto.js';
import { isStandalone } from '../ios.js';

// What a row says once a save lands. None of these is a failure: the bytes are
// on the device and their tags verified during assembly, so the only thing an
// export decides is where they went. A transfer that stayed in the app keeps its
// Save button and waits.
const REPORT = {
  [RUNG.SAVE_PICKER]: 'Saved',
  [RUNG.DOWNLOAD]: 'Saved',
  [RUNG.SHARE]: 'Shared',
  [RUNG.KEEP]: 'Ready to save',
};

// The share sheet is preferred only where nothing below it reaches the operating
// system. Two conditions together say that without asking what browser this is.
// A window with no browser chrome has no downloads shelf and no address bar, so
// a file saved by an anchor can land somewhere the person cannot see. A browser
// with no save picker has no file-writing path of its own either. That pair is
// the shape of a Home Screen web app on iOS. In a tab, or in an installed window
// on a browser that has the picker, the rungs below are better and this stays
// false, which matters because a desktop share sheet offers applications rather
// than a place on disk.
//
// The decision is made here rather than inside the cascade because a share needs
// the user gesture this click is part of, and only the click knows it has one.
function preferShare(file, nav = navigator, win = window) {
  return Boolean(isStandalone(win)
    && typeof win.showSaveFilePicker !== 'function'
    && nav.canShare?.({ files: [file] }));
}

// Assembling and exporting, in the one place both the row's button and the
// arrival notice reach for. One copy because the two must offer the same rung:
// the export cascade spends the user gesture that started the call, and a second
// implementation would drift on which rung it reaches for and where the file
// lands. Imported here rather than at the top so the direct-transfer path stays
// out of the boot path, exactly as the rest of this module loads it.
async function saveTransfer(transferId, meta = null) {
  const { assembleTransfer } = await import('../receive.js');
  // The row already decrypted this transfer's metadata to draw its name, and
  // handing it over is what lets an already-assembled file reach the export
  // with no network in between. A save picker and a share sheet both spend the
  // click's gesture, and a gesture does not survive two round trips.
  const file = await assembleTransfer(transferId, { meta });
  return exportFile(file, { preferShare: preferShare(file) });
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// openMeta returns either the transfer's meta record or the reason the row
// cannot vouch for one.
//
// The mode byte decides whether the record is authenticated at all, and it
// carries no tag of its own. A plaintext record opens with no key, so its name
// and size would be whatever the writer chose, and a forged one would render as
// an ordinary row under a filename an attacker picked. Nothing in this build
// ever sends unsealed, so an unsealed record is refused and labeled with the
// words the visual spec reserves for exactly that state.
async function openMeta(mk, t) {
  const unvouched = `from ${t.sender} · sealed with a different passphrase`;
  let record;
  try {
    record = b64decode(t.meta);
  } catch {
    return { detail: unvouched };
  }
  if (modeOf(record) !== MODE_SEALED) {
    return { detail: 'Not sealed. Anyone with access to the server can read this.' };
  }
  try {
    return {
      meta: JSON.parse(new TextDecoder().decode(
        await openRecord(mk, DOMAIN.META, t.id, record))),
    };
  } catch {
    // Sealed under a different passphrase, or tampered with. Say so rather than
    // showing a name we cannot vouch for.
    return { detail: unvouched };
  }
}

// Everything a row turns on, decided before a node is built and with no document
// in reach.
//
// Two questions, independent, and each has its own authority.
//
// What to call the transfer is the sealed metadata record's answer. That record
// is uploaded before a chunk moves anywhere, so a name, a size and a picture are
// available long before the bytes are, and gating them on anything else leaves a
// row that cannot say what it is.
//
// Whether it can be saved is a question about whether the server holds every
// chunk, which is what its completeness flag says. There is one delivery path
// and it runs through the server, so that flag is the whole answer.
export async function readRow(t, mk, viewer = null) {
  const outbound = Boolean(viewer && t.sender === viewer);
  const when = ago(t.createdAt);
  const from = outbound ? `sent ${when}` : `from ${t.sender} · ${when}`;
  // The metadata record lands before the chunks do, so a transfer without one is
  // at its first instant rather than in trouble. It is the only nameless row.
  if (!t.meta) {
    return { name: 'Incomplete transfer', detail: from, saveable: false, outbound };
  }

  const { meta, detail: refusal } = await openMeta(mk, t);
  if (!meta) return { name: 'Cannot open', detail: refusal, saveable: false, outbound };

  const detail = `${humanSize(meta.size)} · ${from}`;
  const total = Array.isArray(t.cids) ? t.cids.length : 0;
  if (outbound) {
    return {
      name: meta.name,
      detail,
      meta,
      outbound: true,
      saveable: false,
      note: t.complete ? 'Sent. Available from the server.' : 'Still uploading.',
      reach: t.complete ? total : total - listLength(t.missing),
      total,
      heldAt: t.complete ? every(total) : [],
    };
  }
  if (t.complete) {
    return {
      name: meta.name, detail, meta, saveable: true, reach: total, total, heldAt: every(total),
    };
  }
  // Counted over positions rather than as the id count minus the length of the
  // missing list, which reads the same only while that list carries one entry
  // per position. A file can hold the same chunk many times, and a set of ids
  // cannot say how many positions have landed.
  const cids = Array.isArray(t.cids) ? t.cids : [];
  const missing = new Set(t.missing);
  const heldAt = cids.map((cid, i) => (missing.has(cid) ? -1 : i)).filter((i) => i >= 0);
  return {
    name: meta.name,
    detail,
    meta,
    saveable: false,
    note: `Still arriving. ${heldAt.length} of ${cids.length} chunks so far.`,
    reach: heldAt.length,
    total: cids.length,
    heldAt,
  };
}

const every = (n) => Array.from({ length: n }, (_, i) => i);
const listLength = (value) => (Array.isArray(value) ? value.length : 0);

// The server returns outbound transfers in the Inbox so their sender has a
// place to delete them. They are status rows, not received files: saving would
// have nothing to read, and declining your own send would hide the only
// lifecycle control it has.
export function rowActions({ outbound = false, saveable = false }) {
  const actions = [];
  if (!outbound && saveable) actions.push('save');
  if (!outbound) actions.push('decline');
  actions.push('delete');
  return actions;
}

// The assembled plaintext outlives a successful export so a second Save is
// immediate. Once the server confirms Delete or Decline no row can reach the
// transfer again, so that copy becomes terminal garbage.
export async function cleanLocalTransfer(t, meta, outbound, deps = {}) {
  const remove = deps.removeAssembled || (async (id) => {
    const { removeAssembled } = await import('../assemble.js');
    return removeAssembled(id);
  });
  try {
    await remove(t.id);
  } catch (err) {
    console.warn('local transfer cleanup failed', err);
  }
}

// Reconcile local ownership only after a successful Inbox read. The server is
// authoritative about which transfer ids remain reachable to this device; the
// staging layer independently distinguishes receiver stages from opaque sender
// stages, so this cannot reclaim a queued outbound file by accident.
export async function reconcileLocalTransfers(transfers, deps = {}) {
  const active = new Set(transfers.map((t) => t.id));
  // Stages are a leftover of the removed peer-to-peer path. Nothing writes one
  // any more, so this reclaims what an older version of the app left behind and
  // will find nothing once it has.
  const reconcileStages = deps.reconcileReceiverStages
    || (await import('../staging.js')).reconcileReceiverStages;
  const reconcileOutputs = deps.reconcileAssembled
    || (await import('../assemble.js')).reconcileAssembled;
  const results = await Promise.allSettled([
    reconcileStages(active),
    reconcileOutputs(active),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.warn('terminal local data was not reconciled', result.reason);
  }
}

// A terminal click asks the server and then reclaims what this device holds. If
// the response is lost, a fresh Inbox read tells whether the mutation committed;
// when even that read is unavailable nothing local is thrown away, and the next
// successful reconciliation reclaims it if the transfer did in fact end.
export async function terminateTransfer(t, meta, outbound, mutate, deps = {}) {
  const readInbox = deps.inbox || api.inbox;
  const clean = deps.cleanLocalTransfer || cleanLocalTransfer;

  let mutationError = null;
  try {
    await mutate();
  } catch (err) {
    mutationError = err;
    let active;
    try {
      active = (await readInbox()).some((row) => row.id === t.id);
    } catch {
      return { terminal: false, uncertain: true, error: err };
    }
    if (active) return { terminal: false, uncertain: false, error: err };
  }

  await clean(t, meta, outbound);
  return { terminal: true, error: mutationError };
}

// Notifications are what makes a closed app worth closing, and the browser will
// only ask while a click is asking for it. The offer sits here because the inbox
// is where the absence is felt, and it is re-read on every refresh rather than
// decided once at mount: a device can be answered, or blocked, in another tab.
//
// A blocked device is the case that must not be silent. A page cannot prompt
// again once it has been refused, so saying nothing leaves a device permanently
// quiet with no visible reason and nothing to act on.
function renderPushOffer(host) {
  const status = notifyStatus();
  const pushes = pushCapable();

  // The only silent case, and it earns it: this device is fully set up.
  if (status === 'on' && pushes) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;

  // Notifications work, but only while Airlock is running. Said plainly rather
  // than left to be discovered, because the difference only shows up as a file
  // that arrived hours ago and never announced itself.
  if (status === 'on') {
    host.replaceChildren('Notifications are on. This browser can only announce a'
      + ' file while Airlock is open, so leave it running in a tab to hear about'
      + ' arrivals.');
    return;
  }

  // Nothing a click can fix. Saying so is the point: an offer that silently
  // omits itself is indistinguishable from a broken one.
  if (status === 'unavailable') {
    host.replaceChildren('This browser cannot show notifications. Arrivals appear'
      + ' in this list, and in a notice on screen, while Airlock is open.');
    return;
  }

  // A page cannot prompt again once refused, so this one points at the switch.
  if (status === 'blocked') {
    host.replaceChildren('This device stays quiet when a file arrives.'
      + ' Notifications are blocked for this site, and only your browser'
      + ' settings can turn them back on.');
    return;
  }

  const go = el('button', { class: 'ghost', type: 'button' }, 'Turn on notifications');
  go.addEventListener('click', async () => {
    go.disabled = true;
    await enableNotifications();
    renderPushOffer(host);
  });
  host.replaceChildren(pushes
    ? 'Files arrive whether or not this app is open. '
    : 'Get told when a file arrives while Airlock is open. ', go);
}

registerView('inbox', 'Inbox', (panel) => {
  const list = el('ul', { class: 'rows' });
  const ask = el('p', { class: 'muted notice', hidden: true });
  panel.append(el('h2', {}, 'Inbox'), ask, list);
  renderPushOffer(ask);

  // Which refresh owns the list. Rows are built before anything on screen is
  // touched, and a run that is overtaken while awaiting drops its work rather
  // than appending it under a newer one's. Two triggers can now land in the same
  // turn, and the interleaved alternative shows every row twice.
  let generation = 0;
  // The object URLs currently attached to rows on screen. Released when the rows
  // they belong to are replaced, and never before, because revoking a URL an
  // <img> is still using can blank it.
  // Which transfers were already saveable the last time this view looked. Null
  // until the first refresh has run, which is what separates "arrived just now"
  // from "was already here when the page opened".
  let prompted = null;
  let showing = [];
  const release = (urls) => {
    for (const url of urls) {
      try { URL.revokeObjectURL(url); } catch { /* already gone */ }
    }
  };

  refresh();
  // The nudge says only that something changed, so the list is re-read rather
  // than patched from the event.
  onInbox(() => refresh());

  async function refresh() {
    // Re-read rather than trusted from mount time. Permission can change in
    // browser settings, or in another tab, with nothing to tell this page about
    // it, and the answer decides whether this device can be reached at all.
    renderPushOffer(ask);
    const mine = ++generation;
    let transfers;
    try {
      transfers = await api.inbox();
    } catch (err) {
      if (mine !== generation) return;
      // An empty list would read as an empty inbox, which is a different fact.
      list.replaceChildren(el('li', { class: 'bad' }, `The inbox did not load. ${err.message}`));
      return;
    }

    if (mine !== generation) return;
    try {
      await reconcileLocalTransfers(transfers);
    } catch (err) {
      // Rendering the authoritative list still matters when local reclamation
      // is temporarily unavailable. A later successful refresh retries it.
      console.warn('local transfers were not reconciled', err);
    }

    if (transfers.length === 0) {
      if (mine !== generation) return;
      list.replaceChildren(el('li', { class: 'muted' },
        'Nothing waiting. Anything sent from another device lands here.'));
      return;
    }

    // Every thumbnail is a fresh object URL, and this view repaints on every
    // nudge. Without releasing them the decoded image behind each one is held
    // for the life of the page, once per repaint per row.
    const minted = [];
    const rows = [];
    const ready = [];
    for (const t of transfers) {
      rows.push(await row(t, minted, ready));
    }
    // Only what became ready while this view was watching. The first refresh
    // seeds the set instead of announcing it, because everything already in the
    // inbox at boot arrived before anyone was here to be told, and a stack of
    // notices for old transfers on every reload is noise rather than news.
    const announce = prompted === null ? [] : ready.filter((r) => !prompted.has(r.id));
    prompted = new Set(ready.map((r) => r.id));
    for (const { id, name } of announce) {
      toast('Ready to save.', {
        from: name,
        action: {
          label: 'Save',
          run: () => saveTransfer(id, meta).catch(
            (err) => toast(`Could not save. ${err.message}`, { from: name })),
        },
      });
    }
    if (mine !== generation) {
      // This run lost the race and its rows will never be attached, so nothing
      // else will ever release what it minted.
      release(minted);
      return;
    }
    const outgoing = showing;
    showing = minted;
    list.replaceChildren(...rows);
    // After the swap: revoking a URL still attached to an <img> in the document
    // can blank it on some engines.
    release(outgoing);
  }

  async function row(t, minted = [], ready = []) {
    const presentation = await readRow(t, state.mk, state.me?.node);
    const { name, detail, meta, saveable, note, reach, total, heldAt } = presentation;
    const allowedActions = new Set(rowActions(presentation));
    // Recorded where the decision is already made, so the arrival notice and the
    // row's own Save button can never disagree about whether a file is ready.
    if (allowedActions.has('save')) ready.push({ id: t.id, name });

    // Carried by the same record as the name, so it appears with the name rather
    // than waiting on the bytes.
    let thumbEl = null;
    if (meta && t.thumb) {
      try {
        const record = b64decode(t.thumb);
        // The same rule the metadata follows. A plaintext record carries no
        // authentication tag, so a forged one would render as this transfer's
        // own picture. Only a sealed thumbnail is shown.
        if (modeOf(record) === MODE_SEALED) {
          const bytes = await openRecord(state.mk, DOMAIN.THUMB, t.id, record);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          minted.push(url);
          thumbEl = el('img', { class: 'thumb', src: url, alt: '', loading: 'lazy' });
        }
      } catch {
        // A thumbnail that will not open is not worth reporting: the row is
        // still useful without it.
      }
    }

    const detailNode = el('div', { class: 'data muted' }, detail);
    const noteNode = note ? el('div', { class: 'data muted' }, note) : null;

    const actions = el('div', { class: 'actions' });
    // Every row offers the same three words, so a screen reader announces "Save,
    // Decline, Delete" over and over with nothing to say which file is which.
    // The visible label stays short because the name is already above it; the
    // accessible name carries the file, because a control read out of its row
    // has no name above it.
    const about = (verb) => `${verb} ${name}`;
    const terminalAction = async (verb, mutate) => {
      let outcome;
      try {
        outcome = await terminateTransfer(t, meta, presentation.outbound, mutate);
      } catch (err) {
        detailNode.textContent = `Could not ${verb}. ${err.message}`;
        detailNode.className = 'data bad';
        return;
      }
      if (!outcome.terminal) {
        detailNode.textContent = outcome.uncertain
          ? `Could not confirm ${verb}. Local cleanup will reconcile when the inbox reconnects.`
          : `Could not ${verb}. ${outcome.error.message}`;
        detailNode.className = 'data bad';
        return;
      }
      await refresh();
    };
    if (allowedActions.has('save')) {
      // Save assembles on this device and runs the export cascade, rather than
      // navigating to the service worker's download route. That route is a fine
      // rung where it works and a dead end where it does not, and which of those
      // a browser is cannot be detected. Assembling first makes the outcome
      // reportable and the action repeatable.
      const save = el('button', {
        class: 'ghost', type: 'button', 'aria-label': about('Save'),
        onclick: async () => {
          // A save runs for as long as the file is large, and a second one
          // started underneath it would decrypt the same chunks twice.
          save.disabled = true;
          try {
            const rung = await saveTransfer(t.id, meta);
            detailNode.textContent = REPORT[rung];
            detailNode.className = 'data muted';
          } catch (err) {
            detailNode.textContent = `Could not save. ${err.message}`;
            detailNode.className = 'data bad';
          } finally {
            // The button comes back whatever happened. A share sheet or a save
            // picker needs a user gesture, and a long first assembly spends the
            // one this click carried; the second tap finds the file already
            // assembled and reaches the operating system with its gesture
            // intact. A saved file is also worth saving again somewhere else.
            save.disabled = false;
          }
        },
      }, 'Save');
      actions.append(save);
    }
    // Delete removes a transfer for everyone. Decline removes it for you, and
    // the server deletes it once every addressee has refused. Both are offered,
    // because a refusal available only from a notification would be missing
    // wherever the notification was dismissed.
    if (allowedActions.has('decline')) {
      actions.append(el('button', {
        class: 'ghost', type: 'button', 'aria-label': about('Decline'),
        onclick: () => terminalAction('decline', () => api.decline(t.id)),
      }, 'Decline'));
    }
    actions.append(el('button', {
      class: 'ghost', type: 'button', 'aria-label': about('Delete'),
      onclick: () => terminalAction('delete', () => api.deleteTransfer(t.id)),
    }, 'Delete'));

    // The row's divider is the transfer's own composition. Green is what this
    // device can already assemble from, whichever side it came from, and the
    // rest is a hairline. Reading down the list therefore shows which arrivals
    // are whole and which are still filling, without a number per row.
    //
    // Drawn only where it says something. A transfer with no chunk list yet has
    // nothing to report, and a rule that is always full would be decoration.
    const li = el('li', {},
      // Flattened away when there is none, so a row without a thumbnail keeps
      // exactly the shape it had.
      thumbEl || [],
      // The text block absorbs the row's free space so the thumbnail stays
      // against the name it belongs to rather than drifting to the far side.
      el('div', { class: 'rowtext' },
        el('div', { class: 'name' }, name), detailNode, noteNode || []),
      actions);
    if (total > 0) {
      const strip = renderStrip(li, total, {
        seam: true, label: `${reach} of ${total} chunks here`,
      });
      strip.setAll('pending');
      for (const i of heldAt || []) strip.set(i, 'held');
    }
    return li;
  }
});
