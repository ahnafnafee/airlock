import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, MODE_SEALED, openRecord, modeOf, b64decode } from '../crypto.js';

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
  refresh();

  async function refresh() {
    let transfers;
    try {
      transfers = await api.inbox();
    } catch (err) {
      // An empty list would read as an empty inbox, which is a different fact.
      list.replaceChildren(el('li', { class: 'bad' }, `The inbox did not load. ${err.message}`));
      return;
    }
    list.replaceChildren();

    if (transfers.length === 0) {
      list.append(el('li', { class: 'muted' },
        'Nothing waiting. Anything sent from another device lands here.'));
      return;
    }

    for (const t of transfers) {
      list.append(await row(t));
    }
  }

  async function row(t) {
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

    const detailNode = el('div', { class: 'data muted' }, detail);

    const actions = el('div', { class: 'actions' });
    if (openable) {
      actions.append(el('a', { class: 'ghost', href: `/dl/${t.id}`, download: '' }, 'Save'));
    }
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
