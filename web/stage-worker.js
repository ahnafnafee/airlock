// The staging worker the page posts to. It exists because createSyncAccessHandle
// is callable only from a dedicated worker global scope, and it does nothing but
// carry a chunk from the page to the one write path in staging.js.
//
// The protocol is one message per chunk carrying a ticket, and one reply per
// ticket carrying either nothing or an error message. Tickets rather than order
// because several writes may be in flight and replies are not promised in the
// order the writes were posted.

import { writeStaged } from './staging.js';

self.addEventListener('message', async (event) => {
  const { ticket, transfer, index, bytes } = event.data || {};
  try {
    await writeStaged(transfer, index, bytes);
    self.postMessage({ ticket });
  } catch (err) {
    // The message crosses rather than the error, because what a failed write
    // owes the page is a reason, and an Error carrying a DOMException name is
    // not clonable everywhere.
    self.postMessage({ ticket, error: String(err?.message || err) });
  }
});
