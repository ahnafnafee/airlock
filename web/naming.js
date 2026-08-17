// Turning a filename into a Content-Disposition header.
//
// Every kind of file transfers, so this has to survive every kind of name:
// spaces, non-ASCII, emoji, quotes, no extension at all, and names chosen by
// another device that may be hostile.

// RFC 6266 defines two parameters and they are encoded differently. The plain
// one is an ASCII fallback carrying the name literally inside quotes; the
// starred one carries percent-encoded UTF-8 and is what current browsers use.
//
// Percent-encoding the plain one, which is the obvious mistake, makes a file
// called "holiday photo.jpg" save as "holiday%20photo.jpg" wherever the
// fallback is honoured.
export function contentDisposition(name) {
  const safe = asciiFallback(name);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function asciiFallback(name) {
  const cleaned = String(name)
    // Anything outside printable ASCII becomes an underscore. This also removes
    // carriage returns and newlines, which would otherwise let a filename from
    // another device inject a header.
    .replace(/[^\x20-\x7e]/g, '_')
    // Quotes and backslashes would end the quoted string early. Escaping is
    // legal but handled inconsistently by older clients, so they are replaced.
    // A forward slash cannot appear in a filename on any platform, so removing
    // it costs nothing and stops a name like "../etc/passwd" reaching a path.
    .replace(/["\\/]/g, '_')
    .trim();

  // A name that is empty, or only dots, is not a filename any platform will
  // accept. "." and ".." in particular are directory entries.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'download';
  return cleaned;
}

// Where a copy number belongs in a filename.
//
// A platform asked to save a name it already has will disambiguate for us, and
// Android appends to the whole display name: "app.apk" becomes "app.apk (2)".
// That is not a cosmetic difference. The result no longer ends in .apk, so
// nothing that decides what a file is by its extension recognises it any more,
// and an installer that would have opened the first copy will not open the
// second. Placing the number before the extension keeps the file the kind of
// file it was.
//
// The split is at the last dot, which is what every file manager does. It makes
// "archive.tar.gz" into "archive.tar (2).gz" rather than "archive (2).tar.gz",
// and that is the conventional answer rather than a mistake.
export function numberedName(name, n) {
  const original = String(name ?? '');
  if (!Number.isInteger(n) || n <= 1) return original;
  const dot = original.lastIndexOf('.');
  // A dot at the front is a hidden file's whole name rather than an extension,
  // so ".bashrc" numbers as ".bashrc (2)" and never as " (2).bashrc".
  if (dot <= 0) return `${original} (${n})`;
  return `${original.slice(0, dot)} (${n})${original.slice(dot)}`;
}
