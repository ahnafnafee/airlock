import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, MODE_SEALED, openRecord, modeOf, b64decode } from '../crypto.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// nameOf returns the filename a tombstone still carries, or the reason the row
// cannot vouch for one.
//
// A tombstone keeps the transfer's sealed metadata, so history renders as a
// list of names only this device can produce: the server holds the same bytes
// and learns nothing from them. Every state that is not a filename says so
// plainly rather than papering over the gap with a guess.
//
// A record that will not open is expected rather than alarming. Re-keying a
// server leaves tombstones no current passphrase can read, and those rows are
// named for what they are.
//
// An unsealed record is refused outright. The mode byte carries no
// authentication tag of its own, so a plaintext record opens under no key at
// all and its name would be whatever the writer chose. Nothing in this build
// ever sends unsealed, so this is the same refusal the inbox makes, in the
// words the visual spec reserves for it.
async function nameOf(t) {
  // A transfer swept before its metadata record landed leaves a tombstone with
  // nothing sealed in it. Nothing was withheld and nothing is wrong, so this is
  // its own state rather than a decryption failure.
  if (!t.meta) return 'Incomplete transfer';

  let record;
  try {
    record = b64decode(t.meta);
  } catch {
    return 'Sealed with a different passphrase';
  }
  if (modeOf(record) !== MODE_SEALED) {
    return 'Not sealed. Anyone with access to the server can read this.';
  }
  try {
    const meta = JSON.parse(new TextDecoder().decode(
      await openRecord(state.mk, DOMAIN.META, t.id, record)));
    return typeof meta.name === 'string' ? meta.name : 'Unnamed transfer';
  } catch {
    return 'Sealed with a different passphrase';
  }
}

registerView('history', 'History', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(el('h2', {}, 'History'), list);
  load();

  async function load() {
    let tombstones;
    try {
      tombstones = await api.history();
    } catch (err) {
      // An empty list would read as "nothing has expired yet", which is a
      // different fact from "the list never arrived".
      list.replaceChildren(
        el('li', { class: 'bad' }, `The history did not load. ${err.message}`));
      return;
    }
    list.replaceChildren();

    if (tombstones.length === 0) {
      list.append(el('li', { class: 'muted' }, 'Nothing has expired yet.'));
      return;
    }

    for (const t of tombstones) {
      const direction = t.sender === state.me.node ? 'sent' : `from ${t.sender}`;
      list.append(el('li', {},
        // The text block absorbs the row's free space so a long filename
        // ellipsizes instead of forcing the row wider than its column.
        el('div', { class: 'rowtext' },
          el('div', { class: 'name' }, await nameOf(t)),
          el('div', { class: 'data muted' }, `${direction} · cleared ${ago(t.endedAt)}`))));
    }
  }
});
