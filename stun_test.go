package main

import (
	"encoding/binary"
	"net"
	"testing"
)

func bindingRequest(txn [12]byte) []byte {
	p := make([]byte, 0, 20)
	p = binary.BigEndian.AppendUint16(p, stunBindingRequest)
	p = binary.BigEndian.AppendUint16(p, 0)
	p = binary.BigEndian.AppendUint32(p, stunMagicCookie)
	return append(p, txn[:]...)
}

// The whole point of answering STUN is the address in this attribute: it is what
// becomes a server-reflexive candidate, and unlike a host candidate a browser
// does not replace it with an unresolvable .local name. Getting the XOR wrong
// produces a candidate pointing at an address nobody is listening on, which
// fails exactly like having no STUN at all.
func TestStunReportsTheAddressItSaw(t *testing.T) {
	txn := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	from := &net.UDPAddr{IP: net.ParseIP("100.86.123.13"), Port: 54321}

	reply, ok := stunReply(bindingRequest(txn), from)
	if !ok {
		t.Fatal("a well formed binding request was not answered")
	}
	if got := binary.BigEndian.Uint16(reply[0:2]); got != stunBindingResponse {
		t.Errorf("reply type %#04x, want %#04x", got, stunBindingResponse)
	}
	// The transaction id must come back untouched or the browser drops the reply.
	for i, b := range txn {
		if reply[8+i] != b {
			t.Fatalf("transaction id changed at byte %d", i)
		}
	}
	if got := binary.BigEndian.Uint16(reply[20:22]); got != stunXorMappedAddr {
		t.Fatalf("attribute %#04x, want XOR-MAPPED-ADDRESS", got)
	}

	// Decode the way a client does, which is the assertion: the port and address
	// have to come back out as the ones the packet actually arrived from.
	port := binary.BigEndian.Uint16(reply[26:28]) ^ uint16(stunMagicCookie>>16)
	if port != 54321 {
		t.Errorf("port decoded as %d, want 54321", port)
	}
	var cookie [4]byte
	binary.BigEndian.PutUint32(cookie[:], stunMagicCookie)
	ip := make(net.IP, 4)
	for i := 0; i < 4; i++ {
		ip[i] = reply[28+i] ^ cookie[i]
	}
	if !ip.Equal(net.ParseIP("100.86.123.13").To4()) {
		t.Errorf("address decoded as %s, want 100.86.123.13", ip)
	}
	if reply[25] != 0x01 {
		t.Errorf("family %#02x, want IPv4", reply[25])
	}
}

func TestStunIgnoresWhatIsNotABindingRequest(t *testing.T) {
	from := &net.UDPAddr{IP: net.ParseIP("100.86.123.13"), Port: 1}
	txn := [12]byte{}

	if _, ok := stunReply(nil, from); ok {
		t.Error("an empty packet was answered")
	}
	if _, ok := stunReply(bindingRequest(txn)[:19], from); ok {
		t.Error("a truncated header was answered")
	}
	// Right length, wrong cookie: not STUN, and answering would mean replying to
	// whatever else happens to arrive on this port.
	bad := bindingRequest(txn)
	binary.BigEndian.PutUint32(bad[4:8], 0xDEADBEEF)
	if _, ok := stunReply(bad, from); ok {
		t.Error("a packet without the magic cookie was answered")
	}
	// A response, not a request. Answering one would let two servers pointed at
	// each other talk forever.
	resp := bindingRequest(txn)
	binary.BigEndian.PutUint16(resp[0:2], stunBindingResponse)
	if _, ok := stunReply(resp, from); ok {
		t.Error("a binding response was answered")
	}
}

func TestStunAnswersIPv6(t *testing.T) {
	txn := [12]byte{9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2}
	from := &net.UDPAddr{IP: net.ParseIP("fd7a:115c:a1e0::d201:a761"), Port: 4444}

	reply, ok := stunReply(bindingRequest(txn), from)
	if !ok {
		t.Fatal("an IPv6 binding request was not answered")
	}
	if reply[25] != 0x02 {
		t.Fatalf("family %#02x, want IPv6", reply[25])
	}
	// IPv6 masks with the cookie followed by the transaction id, not the cookie
	// alone. Using the wrong mask yields a syntactically valid candidate that
	// points nowhere.
	var mask [16]byte
	binary.BigEndian.PutUint32(mask[0:4], stunMagicCookie)
	copy(mask[4:], txn[:])
	ip := make(net.IP, 16)
	for i := 0; i < 16; i++ {
		ip[i] = reply[28+i] ^ mask[i]
	}
	if !ip.Equal(net.ParseIP("fd7a:115c:a1e0::d201:a761")) {
		t.Errorf("address decoded as %s", ip)
	}
}
