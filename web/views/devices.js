import { registerView, state, el } from '../app.js';
import { api } from '../api.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

registerView('devices', 'Devices', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(
    el('h2', {}, 'Devices'),
    el('p', { class: 'muted' },
      'Every device that has reached this server. Tailscale proves they are yours; '
      + 'the passphrase is what lets them read anything.'),
    list);
  refresh();

  async function refresh() {
    let devices;
    try {
      devices = await api.devices();
    } catch (err) {
      // An empty list would read as "nothing has ever reached this server",
      // which cannot be true of the device reading the list.
      list.replaceChildren(
        el('li', { class: 'bad' }, `The device list did not load. ${err.message}`));
      return;
    }
    list.replaceChildren();
    for (const d of devices) {
      list.append(row(d));
    }
  }

  function row(d) {
    const isMe = d.node === state.me.node;

    // Two facts, two words. Approval is about reaching the server; pairing is
    // about being able to read what is on it. A device can be approved and
    // still unable to decrypt a single filename.
    const status = !d.allowed ? 'Blocked'
      : d.paired ? 'Sealed'
        : 'Waiting for the passphrase';
    const statusClass = !d.allowed ? 'data bad'
      : d.paired ? 'data sealed'
        : 'data muted';
    const statusNode = el('div', { class: statusClass }, status);

    const actions = el('div', { class: 'actions' });
    // The device you are sitting at gets no Revoke button on purpose. Revoking
    // it would shut the only interface that could undo the revocation.
    if (!isMe) {
      actions.append(el('button', {
        class: 'ghost',
        type: 'button',
        onclick: async () => {
          try {
            await (d.allowed ? api.revoke(d.node) : api.allow(d.node));
          } catch (err) {
            // A row that does not change after a click reads as a dead button,
            // and the reason it did not change is the one thing worth saying.
            statusNode.textContent =
              `Could not ${d.allowed ? 'revoke' : 'approve'}. ${err.message}`;
            statusNode.className = 'data bad';
            return;
          }
          await refresh();
        },
      }, d.allowed ? 'Revoke' : 'Approve'));
    }

    return el('li', {},
      // The text block absorbs the row's free space so a long node name
      // ellipsizes instead of forcing the row wider than its column.
      el('div', { class: 'rowtext' },
        el('div', { class: 'name data' }, d.node, isMe ? ' (this device)' : ''),
        statusNode,
        el('div', { class: 'data muted' }, `${d.user} · seen ${ago(d.lastSeen)}`)),
      actions);
  }
});
