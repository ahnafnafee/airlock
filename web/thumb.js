// Thumbnails are made here, on the sending device, because the server has never
// seen the image and never will. What leaves this module is sealed under the
// record key with the THUMB domain and stored as an ordinary per-transfer
// record, so the host holds a thumbnail it cannot look at.

export const THUMB_MAX = 256;
const QUALITY = 0.7;

// SVG is deliberately excluded: it is a document that can reference remote
// content and run script when rendered, and drawing an untrusted one to a canvas
// is not a surface worth opening for a format that is already small.
export function thumbnailable(mime) {
  if (!mime) return false;
  if (mime === 'image/svg+xml') return false;
  return mime.startsWith('image/') || mime.startsWith('video/');
}

function fit(width, height) {
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function draw(source, width, height) {
  const [w, h] = fit(width, height);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}

// makeThumbnail returns null rather than throwing for anything it cannot handle.
// A missing thumbnail is normal and must never fail a transfer.
export async function makeThumbnail(file) {
  if (!thumbnailable(file.type)) return null;
  try {
    if (file.type.startsWith('image/')) {
      const bitmap = await createImageBitmap(file);
      try {
        return await draw(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
    return await videoFrame(file);
  } catch {
    return null;
  }
}

function videoFrame(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };

    video.muted = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => done(null));
    video.addEventListener('loadeddata', async () => {
      try {
        done(await draw(video, video.videoWidth, video.videoHeight));
      } catch {
        done(null);
      }
    });
    // Seek slightly in: the first frame of a video is very often black.
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 10);
    });
    video.src = url;
  });
}
