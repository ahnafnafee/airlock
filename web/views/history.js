import { registerView, state, el, onInbox } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, MODE_SEALED, openRecord, modeOf, b64decode } from '../crypto.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// took renders a send duration at a resolution a person can act on. Sub-second
// precision below ten seconds, because that is where the difference between two
// and five matters; whole seconds above it, because nobody times a minute-long
// upload to the tenth.
export function took(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const mins = Math.floor(s / 60);
  return `${mins}m ${String(Math.round(s - mins * 60)).padStart(2, '0')}s`;
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
// The duration comes back with it because both live in the same sealed record,
// and opening it twice would cost a second decryption per row on a phone.
async function nameOf(t) {
  const only = (name) => ({ name, sentMs: null });

  // A transfer swept before its metadata record landed leaves a tombstone with
  // nothing sealed in it. Nothing was withheld and nothing is wrong, so this is
  // its own state rather than a decryption failure.
  if (!t.meta) return only('Incomplete transfer');

  let record;
  try {
    record = b64decode(t.meta);
  } catch {
    return only('Sealed with a different passphrase');
  }
  if (modeOf(record) !== MODE_SEALED) {
    return only('Not sealed. Anyone with access to the server can read this.');
  }
  try {
    const meta = JSON.parse(new TextDecoder().decode(
      await openRecord(state.mk, DOMAIN.META, t.id, record)));
    return {
      name: typeof meta.name === 'string' ? meta.name : 'Unnamed transfer',
      // Absent on anything sent before the sender started recording it, which is
      // a row with no timing rather than a row with a wrong one.
      sentMs: typeof meta.sentMs === 'number' ? meta.sentMs : null,
    };
  } catch {
    return only('Sealed with a different passphrase');
  }
}

// How many rows one page holds. Every row costs a decryption, so a long history
// on a phone is both a wall of text and a wall of work; this is what keeps
// opening the view cheap however much has passed through it. Ten fits a phone
// without scrolling past the point where the pager is reachable.
export const PAGE = 10;

// Which slice of a list a page number covers, and how many pages there are.
// Exported because the arithmetic is the behaviour: an off-by-one here shows up
// as a row nobody can reach.
export function pageOf(total, page, size = PAGE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(1, page), pages);
  return { page: at, pages, from: (at - 1) * size, to: Math.min(total, at * size) };
}

registerView('history', 'History', (panel) => {
  const list = el('ul', { class: 'rows' });
  const pager = el('div', { class: 'pager', hidden: true });
  panel.append(
    el('h2', {}, 'History'),
    el('p', { class: 'muted' }, 'What passed through, after the files themselves are gone.'),
    list,
    pager);
  // Which page is on screen, and everything read for it. Held so paging costs
  // no request: the history is a snapshot of what has already ended.
  let showing = [];
  let page = 1;
  load();
  onInbox(() => load());

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
    showing = tombstones;
    // A reload that shortens the list must not leave the view on a page that no
    // longer exists, which pageOf settles by clamping.
    page = pageOf(showing.length, page).page;
    await paint();
  }

  async function paint() {
    list.replaceChildren();
    pager.replaceChildren();
    pager.hidden = true;

    if (showing.length === 0) {
      list.append(el('li', { class: 'muted' }, 'Nothing has expired yet.'));
      return;
    }

    const at = pageOf(showing.length, page);
    page = at.page;
    for (const t of showing.slice(at.from, at.to)) {
      const direction = t.sender === state.me.node ? 'sent' : `from ${t.sender}`;
      const { name, sentMs } = await nameOf(t);
      // The duration is the sender's, so it is worth saying whose it is on a row
      // that came from somewhere else. Dropped entirely when the record has no
      // timing rather than shown as a zero.
      const spent = took(sentMs);
      const detail = spent
        ? `${direction} · sent in ${spent} · cleared ${ago(t.endedAt)}`
        : `${direction} · cleared ${ago(t.endedAt)}`;
      list.append(el('li', {},
        // The text block absorbs the row's free space so a long filename
        // ellipsizes instead of forcing the row wider than its column.
        el('div', { class: 'rowtext' },
          el('div', { class: 'name' }, name),
          el('div', { class: 'data muted' }, detail))));
    }

    if (at.pages === 1) return;
    const step = (to, label) => {
      const button = el('button', { class: 'ghost', type: 'button' }, label);
      if (to < 1 || to > at.pages) button.disabled = true;
      else button.addEventListener('click', () => { page = to; paint(); });
      return button;
    };
    pager.hidden = false;
    pager.append(
      step(at.page - 1, 'Newer'),
      el('span', { class: 'data muted' },
        `${at.from + 1} to ${at.to} of ${showing.length}`),
      step(at.page + 1, 'Older'));
  }
});
