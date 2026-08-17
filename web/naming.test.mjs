import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDisposition, numberedName } from './naming.js';

// Pull the two parameters apart so each is asserted for what it actually is.
function parts(header) {
  const plain = /filename="([^"]*)"/.exec(header);
  const starred = /filename\*=UTF-8''(\S*)/.exec(header);
  return { plain: plain && plain[1], starred: starred && starred[1] };
}

test('a name with a space is not percent-encoded in the plain parameter', () => {
  // The regression this module exists for. Encoding the fallback saves the file
  // as "holiday%20photo.jpg".
  const { plain, starred } = parts(contentDisposition('holiday photo.jpg'));
  assert.equal(plain, 'holiday photo.jpg');
  assert.equal(starred, 'holiday%20photo.jpg');
});

test('a plain ascii name passes through both parameters', () => {
  const { plain, starred } = parts(contentDisposition('report.pdf'));
  assert.equal(plain, 'report.pdf');
  assert.equal(decodeURIComponent(starred), 'report.pdf');
});

test('non-ascii names survive in the starred parameter', () => {
  for (const name of ['日本語.txt', 'ræksmørbrød.txt', 'файл.bin', '🎉 party.gif']) {
    const { plain, starred } = parts(contentDisposition(name));
    assert.equal(decodeURIComponent(starred), name, `starred lost ${name}`);
    assert.ok(/^[\x20-\x7e]*$/.test(plain), `fallback for ${name} is not ascii: ${plain}`);
    assert.ok(plain.length > 0);
  }
});

test('a quote cannot end the quoted string early', () => {
  const header = contentDisposition('evil".jpg');
  const { plain } = parts(header);
  assert.ok(!plain.includes('"'));
  // One quoted region only, so nothing after it was smuggled in as a parameter.
  assert.equal((header.match(/"/g) || []).length, 2);
});

test('a newline in a name cannot inject a header', () => {
  // Filenames come from another device and are attacker-shaped the moment one
  // is compromised. The property that matters is that no line break survives:
  // the text between them is an ordinary part of a filename and stays, which is
  // right, because inside a quoted string with no newline it cannot become a
  // header of its own.
  const header = contentDisposition('a\r\nX-Injected: yes\r\n.txt');
  assert.ok(!header.includes('\r'), 'a carriage return survived');
  assert.ok(!header.includes('\n'), 'a line feed survived');
  assert.equal(header.split(/\r|\n/).length, 1);
});

test('path separators are removed from the fallback', () => {
  assert.ok(!parts(contentDisposition('../../etc/passwd')).plain.includes('/'));
  assert.ok(!parts(contentDisposition('a\\b.txt')).plain.includes('\\'));
});

test('a name that is empty or only dots falls back to something usable', () => {
  for (const name of ['', '   ', '.', '..', '...']) {
    const { plain } = parts(contentDisposition(name));
    assert.equal(plain, 'download', `bad fallback for ${JSON.stringify(name)}`);
  }
});

test('a file with no extension is left alone', () => {
  // Common for archives, disk images, and anything from a unix machine.
  assert.equal(parts(contentDisposition('Makefile')).plain, 'Makefile');
  assert.equal(parts(contentDisposition('LICENSE')).plain, 'LICENSE');
});

test('unusual but legitimate names are preserved', () => {
  for (const name of [
    'archive.tar.gz',
    'v1.2.3-rc1+build.5.bin',
    'notes (final) [edited].md',
    "it's a file, isn't it.txt",
    'a'.repeat(200) + '.dat',
    '.gitignore',
    '~$tempdoc.docx',
  ]) {
    assert.equal(parts(contentDisposition(name)).plain, name, `mangled ${name}`);
  }
});

test('a reserved windows device name is carried, not renamed', () => {
  // CON, PRN, AUX, NUL and the COM and LPT series cannot be filenames on
  // Windows, with or without an extension, and are ordinary filenames
  // everywhere else. Rewriting one here would decide for every platform on
  // behalf of the one it is a problem on, and would mean a file that arrives
  // under a name nobody chose. The browser's download manager is what knows
  // the rules of the disk it is writing to.
  for (const name of ['CON', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT1', 'con.txt']) {
    const { plain, starred } = parts(contentDisposition(name));
    assert.equal(plain, name, `mangled ${name}`);
    assert.equal(decodeURIComponent(starred), name, `starred lost ${name}`);
  }
});

test('every parameter stays on one line', () => {
  const header = contentDisposition('perfectly normal.txt');
  assert.equal(header.split('\n').length, 1);
});

// A platform that disambiguates for us appends to the whole display name, so
// "app.apk" becomes "app.apk (2)" and stops being an apk as far as anything
// reading the extension is concerned. Numbering it ourselves is the only way to
// keep the extension where it belongs.
test('a copy number goes before the extension, not after it', () => {
  assert.equal(numberedName('player2-production.apk', 2), 'player2-production (2).apk');
  assert.equal(numberedName('player2-production.apk', 11), 'player2-production (11).apk');
  // The first copy is the name itself. Numbering from one would put "(1)" on
  // every file anyone ever saved.
  assert.equal(numberedName('holiday.mp4', 1), 'holiday.mp4');
  assert.equal(numberedName('holiday.mp4', 0), 'holiday.mp4');
});

test('names without a normal extension still number sensibly', () => {
  // Nothing to split on, so the number goes at the end, which is where it would
  // have gone anyway.
  assert.equal(numberedName('README', 2), 'README (2)');
  // A leading dot is the whole name of a hidden file, not an extension.
  assert.equal(numberedName('.bashrc', 2), '.bashrc (2)');
  // The conventional split is the last dot, which every file manager uses.
  assert.equal(numberedName('archive.tar.gz', 2), 'archive.tar (2).gz');
  // A trailing dot leaves an empty extension rather than losing the number.
  assert.equal(numberedName('odd.', 2), 'odd (2).');
});

test('a name that is not a string cannot crash a save', () => {
  assert.equal(numberedName(undefined, 2), ' (2)');
  assert.equal(numberedName(null, 1), '');
});
