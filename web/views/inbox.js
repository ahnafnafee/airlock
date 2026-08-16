import { registerView, state, el, onInbox } from '../app.js';
import { api } from '../api.js';
import { openStage } from '../staging.js';
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

// Which chunk positions this device already holds. Every storage fault reads as
// an empty stage rather than as a failure, because the only thing this decides
// is whether Save is offered, and a transfer that has not started arriving has
// no directory to read.
//
// ponytail: asking opens the staging directory, which creates an empty one for a
// transfer that has never staged anything. The ceiling is one empty directory
// per listed transfer, cleared only when the origin's storage is. Lifting it
// wants an opener in staging.js that does not create.
async function heldHere(transferId, open) {
  try {
    return await (await open(transferId)).held();
  } catch {
    return new Set();
  }
}

// Everything a row turns on, decided before a node is built and with no document
// in reach.
//
// Two questions, independent, and each has its own authority.
//
// What to call the transfer is the sealed metadata record's answer. Both send
// paths upload that record before a chunk moves anywhere, so a name, a size and
// a picture are available long before the bytes are, and gating them on anything
// else leaves a row that cannot say what it is.
//
// Whether it can be saved is a question about where the bytes are, and the
// device doing the saving is the authority on that. Assembly reads a position
// from this device's stage and falls back to the server, so a position is
// reachable when either one holds it. The server's completeness flag speaks for
// the server alone, and on the direct path the server is handed no chunk at all:
// a row that asked only that would refuse to open a file already on this disk.
export async function readRow(t, mk, open = openStage, viewer = null) {
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
  if (outbound) {
    return {
      name: meta.name,
      detail,
      meta,
      outbound: true,
      saveable: false,
      note: t.complete
        ? 'Sent. Available from the server.'
        : (t.held ? 'The server upload has not completed.' : 'Waiting for a recipient.'),
    };
  }
  // Asked first because a transfer the server holds needs nothing from this
  // disk, and asking would open a staging directory for one that never had one.
  const total = Array.isArray(t.cids) ? t.cids.length : 0;
  if (t.complete) {
    return {
      name: meta.name,
      detail,
      meta,
      saveable: true,
      reach: total,
      total,
      heldAt: Array.from({ length: total }, (_, i) => i),
    };
  }

  const cids = Array.isArray(t.cids) ? t.cids : [];
  const here = await heldHere(t.id, open);
  const missing = new Set(t.missing);
  // Counted over positions rather than as the id count minus the length of the
  // missing list, which reads the same only while that list carries one entry
  // per position. A file can hold the same chunk many times, and a set of ids
  // cannot say how many positions have landed.
  const heldAt = cids
    .map((cid, i) => (here.has(i) || !missing.has(cid) ? i : -1))
    .filter((i) => i >= 0);
  const reach = heldAt.length;
  if (cids.length > 0 && reach === cids.length) {
    return {
      name: meta.name, detail, meta, saveable: true, reach, total: cids.length, heldAt,
    };
  }
  return {
    name: meta.name,
    detail,
    meta,
    saveable: false,
    // What the row is waiting for, in the one sentence it takes to say it. The
    // count is the honest part: it is positions this device could assemble from
    // right now, whichever side holds them.
    note: `Still arriving. ${reach} of ${cids.length} chunks so far.`,
    reach,
    total: cids.length,
    heldAt,
  };
}

// The server returns outbound transfers in the Inbox so their sender has a
// place to delete them. They are status rows, not received files: saving would
// look in the receiver's stage, and declining your own send would hide the only
// lifecycle control it has.
export function rowActions({ outbound = false, saveable = false }) {
  const actions = [];
  if (!outbound && saveable) actions.push('save');
  if (!outbound) actions.push('decline');
  actions.push('delete');
  return actions;
}

// Local bytes outlive a successful export so a second Save is immediate. Once
// the server confirms Delete or Decline, no row can reach them again, so both
// the assembled plaintext and this device's stage become terminal garbage.
export async function cleanLocalTransfer(t, meta, outbound, deps = {}) {
  const open = deps.openStage || openStage;
  const remove = deps.removeAssembled || (async (id) => {
    const { removeAssembled } = await import('../assemble.js');
    return removeAssembled(id);
  });
  const senderStage = /^[0-9a-f]{32}$/.test(meta?.stage || '') ? meta.stage : t.id;
  const stageId = outbound ? senderStage : t.id;
  const results = await Promise.allSettled([
    open(stageId).then((stage) => stage.clear()),
    remove(t.id),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.warn('local transfer cleanup failed', result.reason);
  }
}

// Reconcile local ownership only after a successful Inbox read. The server is
// authoritative about which transfer ids remain reachable to this device; the
// staging layer independently distinguishes receiver stages from opaque sender
// stages, so this cannot reclaim a queued outbound file by accident.
export async function reconcileLocalTransfers(transfers, deps = {}) {
  const active = new Set(transfers.map((t) => t.id));
  const reconcileReceives = deps.reconcileReceives || (await import('../session.js')).reconcileReceives;
  await reconcileReceives(active);

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

// A terminal click is a small two-phase operation. First stop and join any live
// receiver, then ask the server. If the response is lost, a fresh Inbox read
// tells whether the mutation committed. When even that read is unavailable the
// receiver is allowed to resume; the next successful Inbox reconciliation will
// stop it and reclaim its bytes if the transfer did in fact end.
export async function terminateTransfer(t, meta, outbound, mutate, deps = {}) {
  const session = deps.cancelReceive && deps.resumeReceive ? deps : await import('../session.js');
  const cancel = deps.cancelReceive || session.cancelReceive;
  const resume = deps.resumeReceive || session.resumeReceive;
  const readInbox = deps.inbox || api.inbox;
  const clean = deps.cleanLocalTransfer || cleanLocalTransfer;

  await cancel(t.id);
  let mutationError = null;
  try {
    await mutate();
  } catch (err) {
    mutationError = err;
    let active;
    try {
      active = (await readInbox()).some((row) => row.id === t.id);
    } catch {
      resume(t.id);
      return { terminal: false, uncertain: true, error: err };
    }
    if (active) {
      resume(t.id);
      return { terminal: false, uncertain: false, error: err };
    }
  }

  await clean(t, meta, outbound);
  return { terminal: true, error: mutationError };
}

registerView('inbox', 'Inbox', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(el('h2', {}, 'Inbox'), list);

  // Which refresh owns the list. Rows are built before anything on screen is
  // touched, and a run that is overtaken while awaiting drops its work rather
  // than appending it under a newer one's. Two triggers can now land in the same
  // turn, and the interleaved alternative shows every row twice.
  let generation = 0;

  refresh();
  // The nudge says only that something changed, so the list is re-read rather
  // than patched from the event.
  onInbox(() => refresh());
  // The second trigger, and the one no server event can stand in for. The inbox
  // nudge is published once per transfer, when its meta record lands, and that
  // is always before the peer offer that finds this device has no room. Without
  // this a row rendered at nudge time would never start showing the storage note
  // and, worse, would never stop showing it once space was freed and the
  // transfer taken. Dynamically imported for the same reason the rest of this
  // module reaches for session.js that way: the direct-transfer path stays out
  // of the boot path.
  import('../session.js')
    .then(({ onTransferChange }) => onTransferChange(() => refresh()))
    // A list that repaints on the inbox nudge alone is still a list. Worth a
    // line, because the note it can no longer retire is one a person acts on.
    .catch((err) => console.warn('the storage note will not repaint', err));

  async function refresh() {
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

    // Read through a dynamic import for the same reason the save path below
    // uses one: the direct-transfer module stays out of the boot path. By the
    // time a row renders the app has loaded it, so this is a module-map lookup.
    let shortfallFor = () => 0;
    try {
      ({ shortfallFor } = await import('../session.js'));
    } catch (err) {
      // A row without this note is still a row worth showing.
      console.warn('the storage note was not read', err);
    }

    const rows = [];
    for (const t of transfers) {
      rows.push(await row(t, shortfallFor));
    }
    if (mine !== generation) return;
    list.replaceChildren(...rows);
  }

  async function row(t, shortfallFor = () => 0) {
    const presentation = await readRow(t, state.mk, openStage, state.me?.node);
    const { name, detail, meta, saveable, note, reach, total, heldAt } = presentation;
    const allowedActions = new Set(rowActions(presentation));

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
          thumbEl = el('img', { class: 'thumb', src: url, alt: '', loading: 'lazy' });
        }
      } catch {
        // A thumbnail that will not open is not worth reporting: the row is
        // still useful without it.
      }
    }

    // Running out of room is the one arrival failure the person holding this
    // device can undo, and it is silent everywhere else: the sender keeps the
    // transfer queued and says nothing about why, and a console line is a
    // message to a developer rather than to an owner. So the row says what
    // happened and what to do, and the transfer lands on its own once it is
    // done, with no button to press here.
    const short = shortfallFor(t.id);
    const detailNode = short > 0
      ? el('div', { class: 'data bad' },
        `Not enough space. Free about ${humanSize(short)} and this arrives on its own.`)
      : el('div', { class: 'data muted' }, detail);

    // Suppressed under the storage note, which is about the same wait and is the
    // half a person can act on.
    const noteNode = note && short === 0
      ? el('div', { class: 'data muted' }, note)
      : null;

    const actions = el('div', { class: 'actions' });
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
        class: 'ghost', type: 'button',
        onclick: async () => {
          // A save runs for as long as the file is large, and a second one
          // started underneath it would decrypt the same chunks twice.
          save.disabled = true;
          try {
            // Imported here rather than at the top so the whole direct-transfer
            // path stays out of the boot path, exactly as the app loads it.
            const { assembleTransfer } = await import('../session.js');
            const file = await assembleTransfer(t.id);
            const rung = await exportFile(file, { preferShare: preferShare(file) });
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
        class: 'ghost', type: 'button',
        onclick: () => terminalAction('decline', () => api.decline(t.id)),
      }, 'Decline'));
    }
    actions.append(el('button', {
      class: 'ghost', type: 'button',
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
