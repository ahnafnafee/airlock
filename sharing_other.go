//go:build !windows

package main

import "os"

// Unix removes a directory entry independently of open handles, so nothing
// special is needed here.
func openShared(path string) (*os.File, error) { return os.Open(path) }
