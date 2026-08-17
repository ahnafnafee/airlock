import {
  registerView, showView, state, el, onDevices, onInbox, notifyInbox,
} from '../app.js';
import { api } from '../api.js';
import { uploadThroughServer } from '../upload.js';
import { renderStrip } from '../strip.js';
import { MODE_SEALED } from '../crypto.js';
import { capabilities, onCapabilities, installCard, filesFromDrop } from '../inbound.js';

// The value that means every device rather than one. It is a real choice on the
// list and not the empty value, because empty has to keep meaning "not yet
// answered": a Send that read them as the same thing would treat a question
// nobody answered as permission to send to everything.
export const EVERY_DEVICE = '*';

let sendImpl = { server: uploadThroughServer };

// Test seam. Production never calls this.
export function __setSendImpl(impl) { sendImpl = impl; }

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
  // A File can be a live handle to disk. Snapshot its bytes while the picker,
  // drop or share event still owns a readable source, so a later rename, move
  // or replacement cannot change the two-pass held upload between reads.
  staged.push(...files.map((file) => new File([file.slice()], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  })));
  renderStaged();
}

// A shared link or a shared note arrives as text with no file behind it. It
// travels as a file like everything else, so the staging list, the upload loop
// and the inbox all have one kind of row.
export function stageText(text) {
  stageFiles([new File([text], noteName(text), { type: 'text/plain' })]);
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
  // The chamber said nothing about itself: every word in it was on a button, so
  // an empty one read as a panel that had failed to load. This is the line that
  // says what the chamber is for, and it is always here, unlike the drop line
  // above which appears only on an engine that has proved it accepts a drag.
  const hatch = el('p', { class: 'hatch' }, 'Nothing staged yet');
  // The two choices sit side by side on one line: they are alternatives, and
  // stacking them made the second read as a lesser afterthought of the first.
  const drop = el('div', { id: 'drop' },
    hatch,
    el('div', {}, dropLine),
    el('div', { class: 'row' }, choose, folderButton),
    picker, folder);

  // Both are receipts, so both start hidden on every browser and stay hidden
  // forever on the ones that never deliver. Nothing here is read from the
  // manifest or from a user agent string.
  // The readout under the chamber. Sealing is not a setting any more, it is what
  // this product does, and until now the one fact that distinguishes it was the
  // only fact the interface never stated. It sits under the chamber because that
  // is where it becomes true: a file is sealed on the way in, before anything
  // leaves. Green, in the one sense that color carries.
  const seal = el('p', { class: 'data sealed' },
    'Sealed on this device. The server stores what it cannot read.');

  const pasteHint = el('p', { class: 'data muted', hidden: true },
    'You can also paste a file into this window.');
  const installNote = el('p', { class: 'data muted', hidden: true });

  // Nothing is chosen until someone chooses it. Where a file goes is the one
  // decision on this screen that cannot be taken back, so it is never inherited
  // from a previous send, from a device list that happened to reload, or from a
  // browser restoring a select's value across a reload on its own, which is what
  // autocomplete off is for. Every device is a choice on the list, not the
  // absence of one.
  const recipient = el('select', { id: 'to', autocomplete: 'off' },
    el('option', { value: '' }, 'Choose where this goes'),
    el('option', { value: EVERY_DEVICE }, 'All my devices'));
  // No visible heading, because the list has to disappear when it is empty. The
  // accessible name carries what the heading would have said.
  const stagedList = el('ul', { class: 'rows staged', 'aria-label': 'Staged files' });
  const sendButton = el('button', { class: 'primary', type: 'button', disabled: true }, 'Send');
  // Visible per-chunk copy is intentionally not live: announcing every sealed
  // chunk makes a large transfer unusable with a screen reader. The progressbar
  // remains inspectable throughout, while the separate polite region receives
  // only file-terminal and batch-terminal messages.
  const status = el('div', { class: 'data muted', id: 'send-status' });
  const announcement = el('div', {
    class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
  });
  const progress = el('div', { 'aria-live': 'off' });
  // The key to the strip above it. Hidden until a strip has more than one state
  // to tell apart, because a legend for a single color explains nothing.
  const key = el('div', { hidden: true });
  // Names the position of an edit, under the chunks that carried it.
  const edits = el('div', { hidden: true });
  // Byte offsets under the strip.
  const ruler = el('div', { hidden: true });

  panel.append(
    el('h2', {}, 'Send'),
    el('p', { class: 'muted' }, 'Files are sealed on this device before they leave.'),
    drop,
    seal,
    pasteHint,
    installNote,
    el('p', { class: 'label' }, el('label', { for: 'to' }, 'To')),
    recipient,
    // Above the list rather than below it. Twenty staged files put the only
    // button that does anything a full screen of scrolling away, on the device
    // where scrolling costs the most.
    sendButton,
    stagedList,
    progress,
    ruler,
    edits,
    key,
    status,
    announcement);

  controls = { recipient, progress, ruler, edits, key, status, announcement };

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
    // The chamber says what is in it. It read "Nothing staged yet" over a list
    // of staged files, which is the one sentence on the screen contradicted by
    // the screen itself.
    hatch.textContent = staged.length === 0 ? 'Nothing staged yet'
      : `${staged.length} ${staged.length === 1 ? 'file' : 'files'} ready to send`;
  };

  sendButton.addEventListener('click', async () => {
    if (!recipient.value) {
      status.className = 'data bad';
      status.textContent = 'Choose where this goes first.';
      recipient.focus?.();
      return;
    }
    // Taken off the list before the first byte moves, so a second press cannot
    // send the same files twice and anything staged while this runs is left for
    // the next press.
    const files = staged.splice(0, staged.length);
    renderStaged();
    const failed = await sendNow(files);
    if (failed.length) {
      staged.push(...failed);
      renderStaged();
    }
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
      .filter((d) => d.allowed && d.paired && d.node !== state.me?.node)
      .map((d) => d.node);
    // The first two options are the prompt and the standing "all" entry rather
    // than devices, so the comparison starts past them.
    const drawn = [...recipient.children].slice(2).map((o) => o.value);
    // Nothing is touched when nothing changed, so a refresh cannot close an open
    // dropdown or disturb a selection that was never in question.
    if (drawn.length === reachable.length
      && drawn.every((node, i) => node === reachable[i])) return;

    const chosen = recipient.value;
    recipient.replaceChildren(
      el('option', { value: '' }, 'Choose where this goes'),
      el('option', { value: EVERY_DEVICE }, 'All my devices'));
    for (const node of reachable) recipient.append(el('option', { value: node }, node));
    // The selection survives the rebuild. Resetting it because a list reloaded
    // would send the next press of Send somewhere nobody picked, which is a
    // worse fault than the staleness this refresh exists to cure.
    recipient.value = chosen === EVERY_DEVICE || reachable.includes(chosen) ? chosen : '';
    // Losing the destination is the one case the selection cannot be kept, and
    // it is said out loud: quietly widening one device to all of them is exactly
    // the silent change the line above refuses to make.
    if (chosen && recipient.value !== chosen) {
      status.className = 'data bad';
      status.textContent = `${chosen} can no longer be reached, so nothing is chosen.`;
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
  // An inbox nudge can introduce the sender of a new transfer, while a devices
  // event covers approval, revocation and pairing completion even when no file
  // moves. Both answers are re-read rather than patched from event payloads.
  onInbox(() => refreshRecipients());
  onDevices(() => refreshRecipients());

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

// Held chunks were never uploaded and must never render as newly stored. The
// green outline and green fill are different states, and that distinction is
// the whole point of the strip.
//
// Where a chunk sits matters as much as which state it is in. The strip is a
// row in file order, so its reader takes a segment's place as that chunk's
// place in the file. Painting held chunks as a block from the start would show
// a file whose middle changed as one whose tail did, which is exactly the
// question a delta makes interesting. The uploader reports the positions, so
// they are painted where they belong.
//
// The direct path reports no positions, because on it nothing is held and
// nothing is on a wire until a peer session opens. It falls back to counts,
// which is all there is to say about a file being sealed onto this device.
function paintStrip(strip, p) {
  if (!p.heldAt) {
    strip.setRange(0, p.held || 0, 'held');
    strip.setRange(p.held || 0, (p.held || 0) + (p.sent || 0), 'stored');
    strip.setRange((p.held || 0) + (p.sent || 0),
      (p.held || 0) + (p.sent || 0) + (p.inflight || 0), 'sending');
    return;
  }
  strip.setAll('pending');
  for (const i of p.heldAt) strip.set(i, 'held');
  for (const i of p.storedAt || []) strip.set(i, 'stored');
  // The chunks on the wire go last, so that inside a segment shared by several
  // chunks the state that is moving is the one you see.
  for (const i of p.inflightAt || []) strip.set(i, 'sending');
}

async function sendNow(files) {
  const {
    recipient, progress, ruler, edits, key, status, announcement,
  } = requireControls();
  const choice = recipient.value;
  const to = choice === EVERY_DEVICE ? [] : [choice];
  // Read once for the whole batch, so a stray click mid-send cannot split one
  // press of Send across two destinations.
  const failures = [];
  let completed = 0;
  announcement.textContent = '';
  for (const file of files) {
    progress.replaceChildren();
    key.replaceChildren();
    key.hidden = true;
    // Reset the tone as well as the text: a failure earlier in the batch would
    // otherwise leave every later success painted as a breach.
    status.className = 'data muted';
    let strip = null;
    let last = null;
    try {
      const opts = {
        mk: state.mk, mode: MODE_SEALED, to, cdc: state.config.cdc, api,
        onProgress: (p) => {
          last = p;
          // A file's chunk count is not known until it has been cut, and the
          // direct path cuts, seals and stages in one pass, so the strip is
          // built when the total arrives rather than drawn against a guess from
          // the file size. A strip with the wrong number of segments is the one
          // thing this element must never be.
          if (!strip && p.total) strip = renderStrip(progress, p.total, { sizes: p.sizes });
          if (strip) { paintStrip(strip, p); strip.legend(key); }
          // On the direct path nothing is held and nothing is on a wire: the
          // count is chunks sealed onto this device. Until the file has been cut
          // there is no total to count against, so the caption counts alone and
          // is the only live feedback that pass has.
          const counted = `${p.held} of ${p.total} held`;
          status.textContent = `${file.name} · ${humanSize(file.size)} · ${counted}`;
          progress.setAttribute('role', 'progressbar');
          progress.setAttribute('aria-label', `Sending ${file.name}`);
          progress.setAttribute('aria-valuemin', '0');
          progress.setAttribute('aria-valuetext', counted);
          if (p.total) {
            progress.setAttribute('aria-valuemax', String(p.total));
            progress.setAttribute('aria-valuenow', String(Math.min(p.total,
              (p.held || 0) + (p.sent || 0))));
          } else {
            progress.removeAttribute('aria-valuemax');
            progress.removeAttribute('aria-valuenow');
          }
        },
      };
      const r = await sendImpl.server(file, opts);
      // Settle the strip. Nothing is in transit once either path resolves, so no
      // segment may be left pulsing amber.
      if (strip) {
        paintStrip(strip, { ...r, inflightAt: [], inflight: 0 });
        strip.legend(key);
        strip.ruler(ruler, file.size);
        // Only on a settled send, because a position is not news until it is
        // final: a chunk still in transit may yet be the one that moved.
        strip.marks(edits, r.storedAt || [], 'the edit');
      }
      status.textContent =
        `Sent ${file.name} · ${r.held} of ${r.total} chunks were already here`;
      announcement.textContent = status.textContent;
      completed++;
    } catch (err) {
      // A failed send leaves nothing in transit either, and the chunks that
      // never landed are queued, not stored.
      if (strip && last) {
        strip.setRange(last.held + last.sent, last.total, 'pending');
        strip.legend(key);
      }
      status.textContent = `${file.name} did not send. ${err.message}`;
      status.className = 'data bad';
      announcement.textContent = status.textContent;
      failures.push({ file, err });
    }
  }

  if (failures.length) {
    const count = failures.length;
    const sent = completed ? `${completed} ${completed === 1 ? 'file was' : 'files were'} sent or queued. ` : '';
    const names = failures.map(({ file }) => file.name).join(', ');
    status.textContent = `${sent}${count} ${count === 1 ? 'file did' : 'files did'} not send and ${count === 1 ? 'is' : 'are'} ready to retry: ${names}.`;
    status.className = 'data bad';
    announcement.textContent = status.textContent;
  }

  // Upload announcements deliberately exclude their sender. Tell this page's
  // own listeners so an Inbox mounted in another view reflects every transfer
  // that this batch successfully created, without turning it into an arrival.
  if (completed > 0) notifyInbox();

  return failures.map(({ file }) => file);
}
