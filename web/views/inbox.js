import { registerView, state, el, onInbox } from '../app.js';
import { api } from '../api.js';
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
    .then(({ onStorageNote }) => onStorageNote(() => refresh()))
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
    let name = 'Incomplete transfer';
    let detail = `from ${t.sender} · ${ago(t.createdAt)}`;
    let openable = false;
    let thumbEl = null;

    if (t.complete) {
      const { meta, detail: refusal } = await openMeta(state.mk, t);
      if (meta) {
        name = meta.name;
        detail = `${humanSize(meta.size)} · from ${t.sender} · ${ago(t.createdAt)}`;
        openable = true;
        if (t.thumb) {
          try {
            const record = b64decode(t.thumb);
            // The same rule the metadata follows. A plaintext record carries no
            // authentication tag, so a forged one would render as this
            // transfer's own picture. Only a sealed thumbnail is shown.
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
      } else {
        name = 'Cannot open';
        detail = refusal;
      }
    } else {
      // Counted over positions rather than as the id count minus the length of
      // the missing list, which reads the same only while that list carries one
      // entry per position. A file can hold the same chunk many times, and a
      // set of ids cannot say how many positions have landed.
      const missing = new Set(t.missing);
      const held = t.cids.filter((cid) => !missing.has(cid)).length;
      detail += ` · ${held} of ${t.cids.length} chunks`;
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

    const actions = el('div', { class: 'actions' });
    if (openable) {
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
    actions.append(el('button', {
      class: 'ghost', type: 'button',
      onclick: async () => {
        try {
          await api.decline(t.id);
        } catch (err) {
          detailNode.textContent = `Could not decline. ${err.message}`;
          detailNode.className = 'data bad';
          return;
        }
        await refresh();
      },
    }, 'Decline'));
    actions.append(el('button', {
      class: 'ghost', type: 'button',
      onclick: async () => {
        try {
          await api.deleteTransfer(t.id);
        } catch (err) {
          // A row that stays put after a click reads as a dead button, and the
          // reason it stayed is the one thing worth saying.
          detailNode.textContent = `Could not delete. ${err.message}`;
          detailNode.className = 'data bad';
          return;
        }
        await refresh();
      },
    }, 'Delete'));

    return el('li', {},
      // Flattened away when there is none, so a row without a thumbnail keeps
      // exactly the shape it had.
      thumbEl || [],
      // The text block absorbs the row's free space so the thumbnail stays
      // against the name it belongs to rather than drifting to the far side.
      el('div', { class: 'rowtext' }, el('div', { class: 'name' }, name), detailNode),
      actions);
  }
});
