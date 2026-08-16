import { registerView, showView, state, el, onInbox } from '../app.js';
import { api } from '../api.js';
import { uploadThroughServer, queueForDelivery } from '../upload.js';
import { openStage } from '../staging.js';
import { renderStrip } from '../strip.js';
import { MODE_SEALED, MODE_PLAIN } from '../crypto.js';
import { capabilities, onCapabilities, installCard, filesFromDrop } from '../inbound.js';

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// The nodes an upload draws on belong to the mounted panel, and the upload loop
// reaches them through this. It is set by the same mount that builds the button
// the loop is reached from, so the guard below is a statement of that invariant
// rather than a case anything hits today.
let controls = null;

function requireControls() {
  if (!controls) throw new Error('the send view has not been shown yet');
  return controls;
}

// Files wait here until the owner picks a destination and presses Send. Nothing
// uploads on arrival, whether it came from the drop zone, the Android share
// sheet, or the Windows context menu: choosing where a file goes is the product.
//
// It is also what keeps a forged share harmless. The share POST is a navigation,
// and any page can navigate this browser, so a payload that arrived that way is
// only a proposal until someone presses the same Send a dropped file needs.
//
// The list outlives the mount, and renderStaged is a no-op until the view claims
// it, so a launch that stages before the panel exists is drawn when it mounts
// rather than lost.
const staged = [];
let renderStaged = () => {};

export function stageFiles(files) {
  staged.push(...files);
  renderStaged();
}

// A shared link or a shared note arrives as text with no file behind it. It
// travels as a file like everything else, so the staging list, the upload loop
// and the inbox all have one kind of row.
export function stageText(text) {
  staged.push(new File([text], noteName(text), { type: 'text/plain' }));
  renderStaged();
}

// The note's opening words become its name, so two staged notes are told apart.
// Path separators, control characters and the rest of the set Windows refuses
// are stripped here rather than left to the download side, because this is the
// one filename in the app that whoever started the share chose outright. A stem
// that is empty or nothing but dots is not a name any platform accepts.
function noteName(text) {
  const stem = text.slice(0, 40)
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${/^\.*$/.test(stem) ? 'note' : stem}.txt`;
}

// A name the owner typed over one the device chose. Control characters and the
// separators Windows refuses are dropped; the forward slash is not, because a
// dropped folder puts one in the name on purpose and an edit may well mean to
// keep it. A name that is empty, or nothing but dots and slashes, is not a name
// any platform accepts, so the one it had stands.
function renamed(text, previous) {
  const chosen = String(text)
    .replace(/[\\:*?"<>|\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return /^[.\s/]*$/.test(chosen) ? previous : chosen;
}

registerView('send', 'Send', (panel) => {
  // No accept attribute, on either picker. iOS variously ignores it or
  // over-filters, and the files it breaks on are exactly the ones this product
  // is for: .bin, .enc, anything with no recognized extension. A picker that
  // silently refuses to show a file is worse than one that shows everything.
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  const folder = el('input', {
    type: 'file', multiple: true, hidden: true, webkitdirectory: true,
  });

  // The hatch says only what this browser has been seen to do. The drop line is
  // drawn on the first drag that carries files and not before, so on a phone it
  // never appears and the picker is the whole hatch, which is the honest shape
  // of the weakest inbound story any engine has.
  const dropLine = el('span', { hidden: true }, 'Drop files here, ');
  const choose = el('button', { type: 'button', onclick: () => picker.click() }, 'Choose files');
  // Detected rather than assumed, and verified again after a pick: Firefox on
  // Android accepts this attribute and then returns an empty relative path for
  // every file.
  const folderButton = el('button', {
    type: 'button',
    hidden: !('webkitdirectory' in HTMLInputElement.prototype),
    onclick: () => folder.click(),
  }, 'or a folder');
  // The folder button sits on its own line rather than trailing the first one,
  // so the sentence above it reads the same whether or not the drop line is
  // there. Chained on one line it would say "or choose or a folder".
  const drop = el('div', { id: 'drop' },
    el('div', {}, dropLine, choose),
    folderButton,
    picker, folder);

  // Both are receipts, so both start hidden on every browser and stay hidden
  // forever on the ones that never deliver. Nothing here is read from the
  // manifest or from a user agent string.
  const pasteHint = el('p', { class: 'data muted', hidden: true },
    'You can also paste a file into this window.');
  const installNote = el('p', { class: 'data muted', hidden: true });

  // The sealing state is a control rather than a caption, because it is the one
  // decision on this screen that cannot be undone after the fact. The note is
  // the checkbox's own label, so the state is readable without color: --seal
  // while the key stays on this device, --breach once it does not, and the off
  // text names the consequence instead of describing the setting.
  //
  // The box reads its initial state from state.mode and paintSeal writes the
  // mode back, so the control and the mode uploads read cannot drift apart.
  const sealed = el('input', {
    type: 'checkbox', id: 'sealed', checked: state.mode === MODE_SEALED,
  });
  const sealNote = el('span', {});
  function paintSeal() {
    state.mode = sealed.checked ? MODE_SEALED : MODE_PLAIN;
    sealNote.textContent = sealed.checked
      ? 'Sealed on this device'
      : 'Not sealed. Anyone with access to the server can read this.';
    sealNote.className = sealed.checked ? 'data sealed' : 'data bad';
  }
  paintSeal();
  sealed.addEventListener('change', paintSeal);

  // The one decision on this screen that puts content on the server, and it is
  // off. Left alone, the sealed chunks stay on this device and cross directly
  // when both devices are online. Ticked, they are uploaded, and the note says
  // so rather than describing the setting: what it buys and what it costs are
  // the same sentence.
  const hold = el('input', { type: 'checkbox', id: 'hold' });

  const recipient = el('select', { id: 'to' }, el('option', { value: '' }, 'All my devices'));
  // No visible heading, because the list has to disappear when it is empty. The
  // accessible name carries what the heading would have said.
  const stagedList = el('ul', { class: 'rows staged', 'aria-label': 'Staged files' });
  const sendButton = el('button', { class: 'primary', type: 'button', disabled: true }, 'Send');
  const status = el('div', { class: 'data muted' });
  const progress = el('div');

  panel.append(
    el('h2', {}, 'Send'),
    drop,
    pasteHint,
    installNote,
    el('p', {}, el('label', { for: 'sealed' }, sealed, ' ', sealNote)),
    el('p', {}, el('label', { class: 'choice', for: 'hold' },
      hold,
      el('span', {},
        el('span', {}, 'Hold on the server if I go offline'),
        el('span', { class: 'data muted' },
          'The file is uploaded encrypted so it arrives even if this device is'
          + ' closed. Otherwise it waits here until both devices are online.')))),
    el('p', { class: 'label' }, 'To'),
    recipient,
    stagedList,
    sendButton,
    progress,
    status);

  controls = { recipient, hold, progress, status };

  // Rebuilt whole rather than patched, so the index each Remove closes over is
  // the index that row now has. Same row shape the inbox uses: the text block
  // takes the free space so a long name stays inside its own field instead of
  // pushing the size off a narrow screen.
  renderStaged = () => {
    stagedList.replaceChildren();
    staged.forEach((file, i) => {
      // The name is a field rather than a caption because it is not
      // trustworthy. A pasted screenshot arrives as image.png, and a pick from
      // the iOS photo library arrives as image.jpg under a name its owner has
      // never seen. This is the one chance to fix it, and nothing in the app
      // keys on it.
      const name = el('input', {
        type: 'text', class: 'name', value: file.name,
        'aria-label': `Name for ${file.name}`,
      });
      name.addEventListener('change', () => {
        if (name.value === file.name) return;
        staged[i] = new File([file], renamed(name.value, file.name), { type: file.type });
        renderStaged();
      });
      stagedList.append(el('li', {},
        el('div', { class: 'rowtext' },
          name,
          el('div', { class: 'data muted' }, humanSize(file.size))),
        el('div', { class: 'actions' },
          el('button', {
            class: 'ghost', type: 'button',
            'aria-label': `Remove ${file.name}`,
            onclick: () => { staged.splice(i, 1); renderStaged(); },
          }, 'Remove'))));
    });
    sendButton.disabled = staged.length === 0;
    sendButton.textContent = staged.length > 1 ? `Send ${staged.length} files` : 'Send';
  };

  sendButton.addEventListener('click', async () => {
    // The receiving device checks the seal before it takes an offer, so an
    // unsealed transfer can never be delivered directly and would sit in the
    // queue being retried against every recipient forever. Refused here, before
    // the list is emptied, so the files are still staged when either control is
    // put back.
    if (!hold.checked && !sealed.checked) {
      status.textContent = 'An unsealed file cannot be sent directly.'
        + ' Turn sealing on, or hold it on the server.';
      status.className = 'data bad';
      return;
    }
    // A direct transfer is offered to the devices it names and to nobody else,
    // so one addressed to all devices names no device and would never be
    // offered at all. It would also never leave the queue, because a transfer
    // with no addressee can never be delivered to every addressee. Held on the
    // server the same choice is meaningful: every device sees it in its inbox.
    if (!hold.checked && !recipient.value) {
      status.textContent = 'A file sent directly needs a device to send it to.'
        + ' Choose one, or hold it on the server.';
      status.className = 'data bad';
      return;
    }
    // Taken off the list before the first byte moves, so a second press cannot
    // send the same files twice and anything staged while this runs is left for
    // the next press.
    const files = staged.splice(0, staged.length);
    renderStaged();
    await sendNow(files);
  });

  // The picker is a view of a list the server owns, and that list changes while
  // this view exists: a phone approved from the Devices view next door, or from
  // another tab, has to become selectable without a reload. Nothing tells a
  // person to reload, so a picker built once at mount is a device that cannot be
  // reached at all.
  //
  // Which run owns the picker. A run overtaken while it awaited drops its result
  // rather than drawing it over a newer one's.
  let generation = 0;

  async function refreshRecipients() {
    const mine = ++generation;
    let devices;
    try {
      devices = await api.devices();
    } catch (err) {
      // The options on screen are the last list the server confirmed. Emptying
      // them because one request failed would turn a chosen destination into
      // every device without anyone choosing that.
      console.warn('the recipient list was not refreshed', err);
      return;
    }
    if (mine !== generation) return;
    paintRecipients(devices);
  }

  // A device that cannot read what it is sent is not a destination, and neither
  // is this device: a transfer addressed to yourself has nowhere to go.
  function paintRecipients(devices) {
    const reachable = devices
      .filter((d) => d.allowed && d.node !== state.me?.node)
      .map((d) => d.node);
    // The first option is the standing "All my devices" entry rather than a
    // device, so the comparison starts past it.
    const drawn = [...recipient.children].slice(1).map((o) => o.value);
    // Nothing is touched when nothing changed, so a refresh cannot close an open
    // dropdown or disturb a selection that was never in question.
    if (drawn.length === reachable.length
      && drawn.every((node, i) => node === reachable[i])) return;

    const chosen = recipient.value;
    recipient.replaceChildren(el('option', { value: '' }, 'All my devices'));
    for (const node of reachable) recipient.append(el('option', { value: node }, node));
    // The selection survives the rebuild. Resetting it because a list reloaded
    // would send the next press of Send somewhere nobody picked, which is a
    // worse fault than the staleness this refresh exists to cure.
    recipient.value = reachable.includes(chosen) ? chosen : '';
    // Losing the destination is the one case the selection cannot be kept, and
    // it is said out loud: quietly widening one device to all of them is exactly
    // the silent change the line above refuses to make.
    if (chosen && recipient.value !== chosen) {
      status.className = 'data bad';
      status.textContent = `${chosen} can no longer be reached, so no device is chosen.`;
    }
  }

  refreshRecipients();

  // Being shown is the trigger that matters, because app.js mounts a view at
  // most once: leaving for the Devices view, approving a phone and coming back
  // does not mount this panel again. There is no hook for a view being shown, so
  // the signal is the attribute showView actually writes.
  //
  // ponytail: reading showView's own attribute write is a stand-in for a hook
  // app.js does not offer. An onShow(fn) beside onInbox, or a mount that is
  // handed a show callback, would say this directly and let both views that
  // need it drop the observer.
  new MutationObserver(() => { if (!panel.hidden) refreshRecipients(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  // A window returning to the front has been away long enough for anything to
  // have changed, including while this very panel stayed on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !panel.hidden) refreshRecipients();
  });
  // The one change the server announces. A device approved while this was open
  // makes itself known by sending something, and replying to it needs that
  // device in this picker.
  //
  // ponytail: an approval is not announced at all, so a phone approved from
  // another machine while this screen sits untouched is learned on the next
  // gesture rather than at once. Closing that gap means the server publishing a
  // devices event alongside the inbox one.
  onInbox(() => refreshRecipients());

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, () => drop.classList.add('over'));
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }

  // Both events are canceled, and document wide. Without dragover the browser
  // refuses the drop outright; without drop it navigates this window at the
  // file, which takes the staging list with it. Canceling only over the hatch
  // is the same loss with a smaller target, so a near miss stages too.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    try {
      // The entry handles are taken before this yields, because the transfer
      // and its items stop being readable once the handler returns.
      const files = await filesFromDrop(e.dataTransfer);
      if (!files.length) return;
      showView('send');
      stageFiles(files);
    } catch (err) {
      status.className = 'data bad';
      status.textContent = `Those files could not be read. ${err.message}`;
    }
  });

  picker.addEventListener('change', (e) => {
    stageFiles([...e.target.files]);
    // Cleared so the same file can be chosen again. Without this, a file
    // removed from the list cannot be put back, because the input's value has
    // not changed and no event fires.
    e.target.value = '';
  });

  folder.addEventListener('change', (e) => {
    const picked = [...e.target.files];
    e.target.value = '';
    if (!picked.length) return;
    // The result is checked rather than the attribute. Firefox on Android
    // accepts webkitdirectory and returns an empty relative path for every
    // file, and what was actually delivered is what gets said: reconstructing a
    // hierarchy that never arrived would be an invention.
    const layered = picked.some((f) => f.webkitRelativePath);
    stageFiles(layered
      ? picked.map((f) => new File([f], f.webkitRelativePath, { type: f.type }))
      : picked);
    status.className = 'data muted';
    status.textContent = layered ? ''
      : 'This browser did not report the folder layout, so those files were added as a flat list.';
  });

  // Attached rather than advertised. Firefox on Android does not implement
  // clipboardData.files at all and simply never reaches the line below, which
  // is why the hint above it waits for a delivery instead of a version check.
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    showView('send');
    stageFiles(files);
  });

  // The shell gesture for opening a file, where the modern spelling of the
  // picker exists to hang it on. Elsewhere the key keeps whatever meaning the
  // browser already gave it rather than being handed a broken one.
  if (typeof HTMLInputElement.prototype.showPicker === 'function') {
    document.addEventListener('keydown', (e) => {
      if (panel.hidden || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key?.toLowerCase() !== 'o') return;
      e.preventDefault();
      // showPicker refuses in contexts click() still works in, so a refusal
      // falls back instead of eating the keystroke.
      try { picker.showPicker(); } catch { picker.click(); }
    });
  }

  // What this browser has proved it can do, and nothing else. The first read is
  // asynchronous, so the screen starts at the floor every engine has and grows
  // from there, which is the correct order: an affordance that appears late is
  // an affordance, and one that appears wrongly is a lie.
  const paintInbound = (caps) => {
    dropLine.hidden = !caps.drop;
    choose.textContent = caps.drop ? 'or choose' : 'Choose files';
    pasteHint.hidden = !caps.paste;
    const card = installCard(caps);
    installNote.hidden = card === null;
    installNote.textContent = card || '';
  };
  onCapabilities(paintInbound);
  capabilities().then(paintInbound).catch(() => {});

  // Last, so a share or a launch that staged before this panel existed is on
  // screen the moment it does.
  renderStaged();
});

// The one send loop, and the only thing in this module that touches the network.
// Everything staged leaves through here whether it was dropped, chosen, shared
// from Android or right-clicked in Explorer, because several call sites for one
// behavior is how they drift apart. It is deliberately not exported: the press
// of Send is the only way in, so no launch path can acquire a second one. A file
// that fails is reported on the status line and the batch continues.
//
// The checkbox picks the destination of the sealed chunks and nothing else. Both
// paths chunk, seal and record the transfer identically, so the file the
// recipient ends up with does not depend on which one carried it.
async function sendNow(files) {
  const { recipient, hold, progress, status } = requireControls();
  const to = recipient.value ? [recipient.value] : [];
  // Read once for the whole batch, so a stray click mid-send cannot split one
  // press of Send across two destinations.
  const onServer = hold.checked;
  let anyQueued = false;
  for (const file of files) {
    progress.replaceChildren();
    // Reset the tone as well as the text: a failure earlier in the batch would
    // otherwise leave every later success painted as a breach.
    status.className = 'data muted';
    let strip = null;
    let last = null;
    try {
      const opts = {
        mk: state.mk, mode: state.mode, to, cdc: state.config.cdc, api,
        onProgress: (p) => {
          last = p;
          // A file's chunk count is not known until it has been cut, and the
          // direct path cuts, seals and stages in one pass, so the strip is
          // built when the total arrives rather than drawn against a guess from
          // the file size. A strip with the wrong number of segments is the one
          // thing this element must never be.
          if (!strip && p.total) strip = renderStrip(progress, p.total);
          if (strip) {
            // Held chunks were never uploaded and must never render as stored:
            // the two colors mean different things and the distinction is the
            // whole point of the strip.
            strip.setRange(0, p.held, 'held');
            strip.setRange(p.held, p.held + p.sent, 'stored');
            // The chunks on the wire go last, so that inside a segment shared by
            // several chunks the state that is moving is the one you see.
            strip.setRange(p.held + p.sent, p.held + p.sent + p.inflight, 'sending');
          }
          // On the direct path nothing is held and nothing is on a wire: the
          // count is chunks sealed onto this device. Until the file has been cut
          // there is no total to count against, so the caption counts alone and
          // is the only live feedback that pass has.
          const counted = onServer
            ? `${p.held} of ${p.total} held`
            : (p.total ? `${p.sent} of ${p.total} sealed` : `${p.sent} sealed`);
          status.textContent = `${file.name} · ${humanSize(file.size)} · ${counted}`;
        },
      };
      const r = onServer
        ? await uploadThroughServer(file, opts)
        : await queueForDelivery(file, { ...opts, openStage });
      // Settle the strip. Nothing is in transit once either path resolves, so no
      // segment may be left pulsing amber.
      if (strip) {
        strip.setRange(0, r.held, 'held');
        strip.setRange(r.held, r.total, 'stored');
      }
      status.textContent = onServer
        ? `Sent ${file.name} · ${r.held} of ${r.total} chunks were already here`
        // The same words the checkbox promised, so the confirmation reads as
        // the thing the control said it would do rather than as a new fact.
        : `Queued ${file.name} · it waits here until both devices are online`;
      if (!onServer) anyQueued = true;
    } catch (err) {
      // A failed send leaves nothing in transit either, and the chunks that
      // never landed are queued, not stored.
      if (strip && last) strip.setRange(last.held + last.sent, last.total, 'pending');
      status.textContent = `${file.name} did not send. ${err.message}`;
      status.className = 'data bad';
    }
  }

  // The transfer is on the server's queue from the moment it was created, so
  // this only decides whether it moves now or on the next time the app is
  // opened. Not awaited: a direct session takes as long as the file takes, and
  // the Send view has already said what it did.
  if (anyQueued) {
    const { drainQueue } = await import('../session.js');
    drainQueue().catch((err) => console.warn('the queue did not drain', err));
  }
}
