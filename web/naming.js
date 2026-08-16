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
