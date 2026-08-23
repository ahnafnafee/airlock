// Public routing seam for notification actions. An incomplete transfer may be
// arriving directly on this device, while the server deliberately holds none
// of its chunks, so Accept must let the inbox choose between local staging and
// the server instead of assuming /dl can fetch every chunk.
export function acceptRoute({ id, complete } = {}) {
  return complete === true ? `/dl/${id}` : '/#inbox';
}

export const PUSH_PAYLOAD_VERSION = 1;

const TRANSFER_ID = /^[0-9a-f]{32}$/;

// A push service is outside the trust boundary even though Web Push encrypts
// the payload in transit. Pick only the fields this worker understands, and
// refuse a malformed routing record before it can become notification data or
// a URL. Null is intentionally useful: an older server's empty push still earns
// an immediate generic notification and a best-effort inbox refresh.
export function decodePushMessage(data) {
  let value = data;
  try {
    if (value && typeof value.json === 'function') value = value.json();
  } catch {
    return null;
  }
  if (!value || value.v !== PUSH_PAYLOAD_VERSION) return null;
  if (value.kind === 'test') return { v: PUSH_PAYLOAD_VERSION, kind: 'test' };
  if (value.kind !== 'arrival'
    || typeof value.id !== 'string' || !TRANSFER_ID.test(value.id)
    || typeof value.sender !== 'string' || value.sender.length === 0
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.complete !== 'boolean') return null;

  const out = {
    v: PUSH_PAYLOAD_VERSION,
    kind: 'arrival',
    id: value.id,
    sender: value.sender,
    createdAt: value.createdAt,
    complete: value.complete,
  };
  if (typeof value.meta === 'string' && value.meta.length > 0) out.meta = value.meta;
  return out;
}

// Reliability has a strict order. First show a notification made entirely from
// the push payload; only then touch IndexedDB or the private Airlock origin. A
// sleeping phone may kill either enrichment step, but it cannot take back the
// generic notification that has already been handed to Android.
export function createArrivalHandler({ notify, enrich }) {
  return async (arrival) => {
    const immediate = arrival?.kind === 'arrival'
      ? {
        id: arrival.id,
        sender: arrival.sender,
        createdAt: arrival.createdAt,
        complete: arrival.complete,
      }
      : null;
    await notify(immediate);

    // A normal metadata record fits in the push and remains sealed with the
    // household key. Opening it locally upgrades the notification without a
    // network round trip. A generic notification remains if storage is locked
    // or unavailable.
    if (arrival?.kind === 'arrival' && arrival.meta) {
      try { await notify(arrival); } catch { /* the generic notice already landed */ }
    }

    try {
      const current = await enrich?.(arrival);
      if (current) await notify(current);
    } catch {
      // Enrichment is deliberately never a condition of notification delivery.
    }
    return arrival?.kind === 'arrival' ? arrival.id : null;
  };
}
