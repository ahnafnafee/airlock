const HANDOFF_PATH = /^\/airlock-handoff\/([0-9a-f]{64})$/;

// A launch URL is input, not authority. Anyone can navigate a browser to an
// installed app, so the value is narrowed to the exact loopback shape the
// Windows helper creates. The eventual request is a preflighted POST as well:
// even a forged launch cannot turn Airlock into a GET-shaped CSRF gadget for a
// service that happens to be listening on this machine.
export function handoffURL(targetURL, appOrigin) {
  if (typeof targetURL !== 'string' || !targetURL) return null;
  try {
    const origin = new URL(appOrigin).origin;
    const target = new URL(targetURL);
    if (target.origin !== origin) return null;

    const values = target.searchParams.getAll('handoff');
    if (values.length !== 1) return null;
    const bridge = new URL(values[0]);
    if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1'
      || !bridge.port || bridge.username || bridge.password
      || bridge.search || bridge.hash || !HANDOFF_PATH.test(bridge.pathname)) return null;
    return bridge.href;
  } catch {
    return null;
  }
}

function tokenOf(bridgeURL) {
  const url = new URL(bridgeURL);
  const match = HANDOFF_PATH.exec(url.pathname);
  if (!match) throw new Error('The right-click handoff address is invalid.');
  return match[1];
}

function decodeName(encoded) {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 2048) {
    throw new Error('The right-click handoff did not include a valid filename.');
  }
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - encoded.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // The helper sends Path.GetFileName, so a separator or control character is
    // proof this was not its response. Refuse it rather than manufacturing a
    // path inside a one-file staging row.
    if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error();
    return name;
  } catch {
    throw new Error('The right-click handoff did not include a valid filename.');
  }
}

// Read the one response into a Blob owned by the browser, then give the normal
// staging path a File. The helper never encrypts or uploads: from this point on
// it is indistinguishable from a picker result and the existing Send button is
// still the only path into sealing and transfer.
export async function receiveHandoff(bridgeURL, {
  fetch: fetchImpl = globalThis.fetch,
  File: FileCtor = globalThis.File,
} = {}) {
  const token = tokenOf(bridgeURL);
  const response = await fetchImpl(bridgeURL, {
    method: 'POST',
    headers: { 'X-Airlock-Handoff': token },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    throw new Error(`The right-click handoff answered with HTTP ${response.status}.`);
  }
  if (response.headers.get('X-Airlock-Handoff') !== token) {
    throw new Error('The right-click handoff did not identify itself.');
  }

  const name = decodeName(response.headers.get('X-Airlock-Name'));
  const rawModified = Number(response.headers.get('X-Airlock-Modified'));
  const lastModified = Number.isSafeInteger(rawModified) && rawModified >= 0
    ? rawModified : Date.now();
  const type = (response.headers.get('Content-Type') || 'application/octet-stream')
    .split(';', 1)[0].trim();
  const body = await response.blob();
  return new FileCtor([body], name, { type, lastModified });
}

// Chromium has two launch payload shapes. A declared manifest suffix carries
// FileSystemFileHandles; the context-menu bridge carries a target URL. Keep the
// choice here so neither route can quietly stop staging while the other still
// passes its tests.
export async function launchFiles(params, {
  origin = globalThis.location?.origin,
  receive = receiveHandoff,
} = {}) {
  if (params?.files?.length) {
    return Promise.all(params.files.map((handle) => handle.getFile()));
  }
  const bridge = handoffURL(params?.targetURL, origin);
  return bridge ? [await receive(bridge)] : [];
}
