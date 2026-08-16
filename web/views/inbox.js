import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { DOMAIN, openRecord, b64decode } from '../crypto.js';

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

    if (t.complete) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(
          await openRecord(state.mk, DOMAIN.META, t.id, b64decode(t.meta))));
        name = meta.name;
        detail = `${humanSize(meta.size)} · from ${t.sender} · ${ago(t.createdAt)}`;
        openable = true;
      } catch {
        // Sealed under a different passphrase, or tampered with. Say so rather
        // than showing a name we cannot vouch for.
        name = 'Cannot open';
        detail = `from ${t.sender} · sealed with a different passphrase`;
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
      el('div', {}, el('div', { class: 'name' }, name), detailNode),
      actions);
  }
});
