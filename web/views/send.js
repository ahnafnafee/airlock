import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { upload } from '../upload.js';
import { renderStrip } from '../strip.js';
import { MODE_SEALED, MODE_PLAIN } from '../crypto.js';

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

registerView('send', 'Send', (panel) => {
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  const drop = el('div', { id: 'drop' },
    'Drop files here, ',
    el('button', { type: 'button', onclick: () => picker.click() }, 'or choose'),
    picker);

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
    el('p', {}, el('label', { for: 'sealed' }, sealed, ' ', sealNote)),
    el('p', { class: 'label' }, 'To'),
    recipient,
    stagedList,
    sendButton,
    progress,
    status);

  controls = { recipient, progress, status };

  // Rebuilt whole rather than patched, so the index each Remove closes over is
  // the index that row now has. Same row shape the inbox uses: the text block
  // takes the free space so a long name ellipsizes instead of pushing the size
  // off a narrow screen.
  renderStaged = () => {
    stagedList.replaceChildren();
    staged.forEach((file, i) => {
      stagedList.append(el('li', {},
        el('div', { class: 'rowtext' },
          el('div', { class: 'name' }, file.name),
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
    // Taken off the list before the first byte moves, so a second press cannot
    // send the same files twice and anything staged while this runs is left for
    // the next press.
    const files = staged.splice(0, staged.length);
    renderStaged();
    await sendNow(files);
  });

  api.devices().then((devices) => {
    for (const d of devices) {
      if (d.node === state.me.node || !d.allowed) continue;
      recipient.append(el('option', { value: d.node }, d.node));
    }
  }).catch(() => {});

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => { e.preventDefault(); stageFiles([...e.dataTransfer.files]); });
  picker.addEventListener('change', (e) => stageFiles([...e.target.files]));

  // Last, so a share or a launch that staged before this panel existed is on
  // screen the moment it does.
  renderStaged();
});

// The one upload loop, and the only thing in this module that touches the
// network. Everything staged leaves through here whether it was dropped, chosen,
// shared from Android or right-clicked in Explorer, because several call sites
// for one behavior is how they drift apart. It is deliberately not exported: the
// press of Send is the only way in, so no launch path can acquire a second one.
// A file that fails is reported on the status line and the batch continues.
async function sendNow(files) {
  const { recipient, progress, status } = requireControls();
  const to = recipient.value ? [recipient.value] : [];
  for (const file of files) {
    progress.replaceChildren();
    // Reset the tone as well as the text: a failure earlier in the batch would
    // otherwise leave every later success painted as a breach.
    status.className = 'data muted';
    let strip = null;
    let last = null;
    try {
      const r = await upload(file, {
        mk: state.mk, mode: state.mode, to, cdc: state.config.cdc, api,
        onProgress: (p) => {
          if (!strip) strip = renderStrip(progress, p.total);
          last = p;
          // Held chunks were never uploaded and must never render as stored:
          // the two colors mean different things and the distinction is the
          // whole point of the strip.
          strip.setRange(0, p.held, 'held');
          strip.setRange(p.held, p.held + p.sent, 'stored');
          // The chunks on the wire go last, so that inside a segment shared by
          // several chunks the state that is moving is the one you see.
          strip.setRange(p.held + p.sent, p.held + p.sent + p.inflight, 'sending');
          status.textContent =
            `${file.name} · ${humanSize(file.size)} · ${p.held} of ${p.total} held`;
        },
      });
      // Settle the strip. Nothing is in transit once upload resolves, so no
      // segment may be left pulsing amber.
      if (strip) {
        strip.setRange(0, r.held, 'held');
        strip.setRange(r.held, r.total, 'stored');
      }
      status.textContent = `Sent ${file.name} · ${r.held} of ${r.total} chunks were already here`;
    } catch (err) {
      // A failed send leaves nothing in transit either, and the chunks that
      // never landed are queued, not stored.
      if (strip && last) strip.setRange(last.held + last.sent, last.total, 'pending');
      status.textContent = `${file.name} did not send. ${err.message}`;
      status.className = 'data bad';
    }
  }
}
