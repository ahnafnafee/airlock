import { registerView, state, el } from '../app.js';
import { api } from '../api.js';
import { upload } from '../upload.js';
import { renderStrip } from '../strip.js';

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

registerView('send', 'Send', (panel) => {
  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  const drop = el('div', { id: 'drop' },
    'Drop files here, ',
    el('button', { type: 'button', onclick: () => picker.click() }, 'or choose'),
    picker);

  const recipient = el('select', { id: 'to' }, el('option', { value: '' }, 'All my devices'));
  const status = el('div', { class: 'data muted' });
  const progress = el('div');

  panel.append(
    el('h2', {}, 'Send'),
    drop,
    el('p', { class: 'label' }, 'To'),
    recipient,
    progress,
    status);

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
  drop.addEventListener('drop', (e) => { e.preventDefault(); send([...e.dataTransfer.files]); });
  picker.addEventListener('change', (e) => send([...e.target.files]));

  async function send(files) {
    const to = recipient.value ? [recipient.value] : [];
    for (const file of files) {
      progress.replaceChildren();
      // Reset the tone as well as the text: a failure earlier in the batch would
      // otherwise leave every later success painted as a breach.
      status.className = 'data muted';
      let strip = null;
      try {
        const r = await upload(file, {
          mk: state.mk, mode: state.mode, to, cdc: state.config.cdc, api,
          onProgress: (p) => {
            if (!strip) strip = renderStrip(progress, p.total);
            // Held chunks were never uploaded and must never render as stored:
            // the two colors mean different things and the distinction is the
            // whole point of the strip.
            strip.setRange(0, p.held, 'held');
            strip.setRange(p.held, p.held + p.sent, 'stored');
            status.textContent =
              `${file.name} · ${humanSize(file.size)} · ${p.held} of ${p.total} held`;
          },
        });
        status.textContent = `Sent ${file.name} · ${r.held} of ${r.total} chunks were already here`;
      } catch (err) {
        status.textContent = `${file.name} did not send. ${err.message}`;
        status.className = 'data bad';
      }
    }
  }
});
