//go:build windows

package main

import (
	"os"
	"syscall"
)

// openShared opens a file for reading in a way that still lets the file be
// deleted while the handle is open, which is what Unix does for free. Without
// FILE_SHARE_DELETE, Windows blocks the remove in Sweep and the RemoveAll
// behind a transfer deletion. That second one is the damaging case: Delete
// writes the tombstone before removing the directory, so a blocked removal
// leaves history saying the transfer ended while the inbox entry survives.
// A reader keeps the bytes it opened either way.
//
// Renaming over a file someone holds open stays blocked, because MoveFileEx
// refuses a target with any open handle no matter the share mode. Removing the
// target first is what makes such a replacement possible, and this share mode
// is what lets that removal succeed.
//
// ponytail: no \\?\ prefixing, so this shares the legacy 260 character path
// ceiling that os.Open escapes. Chunk and record paths are a fixed depth under
// the data directory and stay far short of it. Prepend the extended-length
// prefix to an absolute, cleaned path if the data directory ever sits deep
// enough for that to bite.
func openShared(path string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := syscall.CreateFile(
		p,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
