// Getting an assembled file out of the app and into the operating system.
//
// The earlier design had one save path, a service worker synthesizing a
// streaming response, and that path has regressed twice in a year on WebKit.
// Betting a platform on it was the mistake. Every rung below is independently
// supported somewhere, so a browser that fails one still saves the file, and the
// last rung is that the file simply waits.
//
// Rung four is the reason no platform can be receive-broken: the bytes are
// already on the device and their tags have verified during assembly. Export is
// a separate, retryable action, and the file waits in the app until one of the
// rungs works.

export const RUNG = {
  // Chromium desktop only, and the best rung where it exists: the browser writes
  // straight to a location the person chose, streaming, with no object URL and
  // no second copy anywhere.
  SAVE_PICKER: 'file-system-access',
  // The service worker's own download route, which is a different shape from the
  // rest: it needs no assembly and it is a navigation rather than a call, so it
  // belongs to whoever builds the link. exportRungs reports whether this browser
  // could answer it; exportFile, which is handed a file that already exists,
  // never takes it.
  STREAM: 'service-worker-stream',
  DOWNLOAD: 'anchor-download',
  SHARE: 'share-sheet',
  KEEP: 'kept-in-app',
};

export function exportRungs(nav = navigator, win = globalThis) {
  return {
    [RUNG.SAVE_PICKER]: typeof win.showSaveFilePicker === 'function',
    [RUNG.STREAM]: 'serviceWorker' in nav,
    [RUNG.DOWNLOAD]: typeof win.URL?.createObjectURL === 'function',
    [RUNG.SHARE]: typeof nav.canShare === 'function',
    // Unconditional, and the reason the cascade has no failure case. A file that
    // reached none of the rungs above is still on the device, still verified,
    // and still exportable on the next tap.
    [RUNG.KEEP]: true,
  };
}

export async function exportFile(file, {
  preferShare = false,
  nav = navigator,
  doc = document,
  win = globalThis,
  urls = URL,
} = {}) {
  // On iOS the share sheet is the rung most likely to reach the Files app, and
  // it needs a user gesture, so the caller passes preferShare from a click
  // handler rather than this module guessing.
  if (preferShare && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return RUNG.SHARE;
    } catch (err) {
      // A canceled share is a decision, not a failure. Falling through to a
      // download would save a file the person just declined to save.
      if (err && err.name === 'AbortError') return RUNG.KEEP;
      // Anything else is the rung failing rather than the person refusing, and
      // the commonest one is a gesture spent by a long assembly. That falls
      // through, and if the rungs below cannot take it either the file is kept
      // and the next tap, which assembles nothing, still has its gesture.
    }
  }

  if (typeof win.showSaveFilePicker === 'function') {
    let writable = null;
    try {
      const handle = await win.showSaveFilePicker({ suggestedName: file.name });
      writable = await handle.createWritable();
      // Streamed rather than written whole, so the file's size never becomes a
      // memory cost on this side either.
      await file.stream().pipeTo(writable);
      return RUNG.SAVE_PICKER;
    } catch (err) {
      // The write is abandoned explicitly, because opening it already replaced
      // whatever was at the chosen path. A write that failed part way and was
      // simply dropped would leave a truncated file exactly where the person
      // asked for a whole one, and the rung below would then report a save that
      // had in fact damaged their file. Aborting discards the attempt and
      // leaves the original alone.
      if (writable) await writable.abort?.().catch(() => {});
      // A dismissed picker is the same decision a canceled share is.
      if (err && err.name === 'AbortError') return RUNG.KEEP;
    }
  }

  try {
    const url = urls.createObjectURL(file);
    const a = doc.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    doc.body.append(a);
    a.click();
    a.remove();
    // Revoked on a timer rather than immediately: revoking while the browser is
    // still fetching the URL cancels the download on some engines.
    setTimeout(() => urls.revokeObjectURL(url), 60000);
    return RUNG.DOWNLOAD;
  } catch {
    // Nothing is lost. The file is in the app and can be exported later.
    return RUNG.KEEP;
  }
}
