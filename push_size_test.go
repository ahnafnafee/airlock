package main

import (
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// A mobile subscription can be registered as a constrained device, and Mozilla's
// autopush refuses a padded record much over two kilobytes on one with 413. The
// library's default is 4096, so taking it means a phone is the single device
// that never hears an arrival, and the refusal is invisible unless the response
// status is read.
//
// The bound is restated rather than imported because it is the assertion: the
// library raising its default must not silently raise ours.
func TestPushRecordFitsAConstrainedDevice(t *testing.T) {
	const constrainedLimit = 2048

	if pushRecordBytes > constrainedLimit {
		t.Errorf("push record %d exceeds what a constrained subscription accepts (%d)",
			pushRecordBytes, constrainedLimit)
	}
	// Below the floor the encoding itself requires, a send fails everywhere.
	if pushRecordBytes < 18 {
		t.Errorf("push record %d is under the aes128gcm minimum", pushRecordBytes)
	}
	if webpush.MaxRecordSize <= constrainedLimit {
		t.Skip("the library default now fits; this guard is about not taking it blindly")
	}
}
