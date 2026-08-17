// Public routing seam for notification actions. An incomplete transfer may be
// arriving directly on this device, while the server deliberately holds none
// of its chunks, so Accept must let the inbox choose between local staging and
// the server instead of assuming /dl can fetch every chunk.
export function acceptRoute({ id, complete } = {}) {
  return complete === true ? `/dl/${id}` : '/#inbox';
}

// Empty push payloads can arrive together after more than one transfer has
// become visible in the inbox. Serialize the read and display as one operation,
// then reserve the transfer that was just displayed so the following push
// chooses the next row even if the browser has not exposed the first
// notification through getNotifications yet.
export function createArrivalQueue({ list, visible, notify, onList, fallback }) {
  let tail = Promise.resolve();
  const announced = new Set();

  const run = async () => {
    let arrivals;
    try {
      arrivals = await list();
    } catch (err) {
      return fallback?.(err);
    }

    await onList?.(arrivals);

    const current = new Set(arrivals.map((transfer) => transfer.id));
    for (const id of announced) {
      if (!current.has(id)) announced.delete(id);
    }

    let notifications = [];
    try {
      notifications = await visible();
    } catch {
      // The in-memory reservation still closes the simultaneous-push race.
    }
    const unavailable = new Set(announced);
    for (const notification of notifications) {
      const id = notification?.data?.id;
      if (id) unavailable.add(id);
    }

    const transfer = arrivals.find((arrival) => !unavailable.has(arrival.id));
    if (!transfer) return null;
    await notify(transfer);
    announced.add(transfer.id);
    return transfer.id;
  };

  return () => {
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  };
}
