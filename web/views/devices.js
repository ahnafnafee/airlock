import { registerView, state, el, onInbox } from '../app.js';
import { api } from '../api.js';

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// What proved these devices is not the same claim on every server, and printing
// the Tailscale one on a server not using Tailscale is simply false. The mode
// comes from the server rather than from anything this device can observe.
function provenance() {
  return state.config?.auth === 'token'
    ? 'Every device that has reached this server. A shared access token is what '
      + 'let them in; the passphrase is what lets them read anything.'
    : 'Every device that has reached this server. Tailscale proves they are '
      + 'yours; the passphrase is what lets them read anything.';
}

registerView('devices', 'Devices', (panel) => {
  const list = el('ul', { class: 'rows' });
  panel.append(
    el('h2', {}, 'Devices'),
    el('p', { class: 'muted' }, provenance()),
    list);
  // Which run owns the list. A run overtaken while it awaited drops its rows
  // rather than drawing them over a newer one's, now that a click and a repaint
  // can land in the same turn.
  let generation = 0;
  // Whether the rows on screen came from the server, which decides what a later
  // failure is allowed to do to them.
  let loaded = false;

  refresh();
  // A device the server learns about is one this list has to show without a
  // reload, and app.js mounts a view at most once: leaving this panel and coming
  // back does not build it again. There is no hook for a view being shown, so
  // the signal is the attribute showView actually writes.
  //
  // ponytail: the send view watches the same attribute for the same reason, and
  // the two copies exist because app.js offers no onShow(fn) for either of them
  // to subscribe to. One hook there replaces both observers.
  new MutationObserver(() => { if (!panel.hidden) refresh(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  // A window returning to the front has been away long enough for a device to
  // have been approved elsewhere while this panel stayed on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !panel.hidden) refresh();
  });
  // The one change the server announces. It says only that something arrived, so
  // the list is re-read rather than patched from the event.
  //
  // ponytail: an approval or a revocation is announced by nothing, so a change
  // made from another machine is learned on the next gesture rather than at
  // once. Closing that gap means the server publishing a devices event.
  onInbox(() => refresh());

  async function refresh() {
    const mine = ++generation;
    let devices;
    try {
      devices = await api.devices();
    } catch (err) {
      if (mine !== generation) return;
      // Rows already drawn are the last list the server confirmed, and a refresh
      // nobody asked for may not replace a real list with an error.
      if (loaded) {
        console.warn('the device list was not refreshed', err);
        return;
      }
      // An empty list would read as "nothing has ever reached this server",
      // which cannot be true of the device reading the list.
      list.replaceChildren(
        el('li', { class: 'bad' }, `The device list did not load. ${err.message}`));
      return;
    }
    if (mine !== generation) return;
    loaded = true;
    list.replaceChildren(...devices.map((d) => row(d)));
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
        el('div', { class: 'data muted' },
          [d.addr, d.user, `seen ${ago(d.lastSeen)}`].filter(Boolean).join(' · '))),
      actions);
  }
});
