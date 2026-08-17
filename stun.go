package main

import (
	"encoding/binary"
	"log"
	"net"
	"net/netip"
)

// A STUN server, in the one shape Airlock needs: answer a Binding Request with
// the address the request arrived from, and ignore everything else.
//
// This exists because of how browsers treat host candidates. A peer connection
// gathers the machine's own interface addresses, and every engine replaces a
// private one with a random <uuid>.local name so a page cannot read the local
// network layout. Resolving that name needs multicast DNS on a shared link.
// A tailnet is a routed tunnel with no multicast, so two devices on one exchange
// candidates neither can resolve, no pair is ever checked, and the transfer sits
// at zero chunks with both sides believing they are connected.
//
// A server-reflexive candidate is not obfuscated, because it is the address the
// world already saw. So the fix is to let each device learn its own tailnet
// address from something that can see it, and Airlock is the one host both
// devices are already talking to. Sending them anywhere else would put a
// third party in the path of a product whose whole claim is that there isn't
// one.
//
// RFC 5389. Only Binding Request is implemented, and only XOR-MAPPED-ADDRESS is
// returned, which is all ICE reads.
const (
	stunBindingRequest  = 0x0001
	stunBindingResponse = 0x0101
	stunMagicCookie     = 0x2112A442
	stunXorMappedAddr   = 0x0020
	stunHeaderBytes     = 20
	// A Binding Request with attributes is still small. Anything larger is not
	// one, and reading it into a fixed buffer bounds what a single packet costs.
	stunMaxPacket = 1280
)

// serveSTUN answers binding requests until the connection is closed. It never
// returns an error to the caller: STUN is an aid to connecting, so a malformed
// packet is dropped rather than being allowed to stop the listener.
func serveSTUN(conn net.PacketConn) {
	buf := make([]byte, stunMaxPacket)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			// A closed listener is the ordinary way this ends.
			return
		}
		reply, ok := stunReply(buf[:n], from)
		if !ok {
			continue
		}
		if _, err := conn.WriteTo(reply, from); err != nil {
			log.Printf("stun reply to %s: %v", from, err)
		}
	}
}

// stunReply builds the response to one packet, or reports that the packet was
// not a binding request this server answers. Split out from the read loop so the
// wire format is testable without a socket.
func stunReply(packet []byte, from net.Addr) ([]byte, bool) {
	if len(packet) < stunHeaderBytes {
		return nil, false
	}
	if binary.BigEndian.Uint16(packet[0:2]) != stunBindingRequest {
		return nil, false
	}
	if binary.BigEndian.Uint32(packet[4:8]) != stunMagicCookie {
		return nil, false
	}
	// The transaction id ties a reply to its request, and for IPv6 it is also
	// part of the mask the address is XORed with.
	var txn [12]byte
	copy(txn[:], packet[8:20])

	udp, ok := from.(*net.UDPAddr)
	if !ok {
		return nil, false
	}
	addr, ok := netip.AddrFromSlice(udp.IP)
	if !ok {
		return nil, false
	}
	addr = addr.Unmap()

	value := xorMappedAddress(addr, uint16(udp.Port), txn)
	reply := make([]byte, 0, stunHeaderBytes+4+len(value))
	reply = binary.BigEndian.AppendUint16(reply, stunBindingResponse)
	reply = binary.BigEndian.AppendUint16(reply, uint16(4+len(value)))
	reply = binary.BigEndian.AppendUint32(reply, stunMagicCookie)
	reply = append(reply, txn[:]...)
	reply = binary.BigEndian.AppendUint16(reply, stunXorMappedAddr)
	reply = binary.BigEndian.AppendUint16(reply, uint16(len(value)))
	reply = append(reply, value...)
	return reply, true
}

// xorMappedAddress encodes the attribute body: a reserved byte, the family, the
// port masked with the top half of the magic cookie, and the address masked with
// the cookie, extended by the transaction id for IPv6.
func xorMappedAddress(addr netip.Addr, port uint16, txn [12]byte) []byte {
	var mask [16]byte
	binary.BigEndian.PutUint32(mask[0:4], stunMagicCookie)
	copy(mask[4:], txn[:])

	family := byte(0x01)
	raw := addr.AsSlice()
	if addr.Is6() {
		family = 0x02
	}

	out := make([]byte, 0, 4+len(raw))
	out = append(out, 0x00, family)
	out = binary.BigEndian.AppendUint16(out, port^uint16(stunMagicCookie>>16))
	for i, b := range raw {
		out = append(out, b^mask[i])
	}
	return out
}

// listenSTUN binds the same addresses the HTTPS listener uses, on UDP. Binding
// the tailnet addresses specifically rather than every interface is the same
// decision made for the same reason: nothing here should be reachable from the
// LAN by accident.
func listenSTUN(addrs []string) ([]net.PacketConn, error) {
	conns := make([]net.PacketConn, 0, len(addrs))
	for _, a := range addrs {
		conn, err := net.ListenPacket("udp", a)
		if err != nil {
			for _, open := range conns {
				open.Close()
			}
			return nil, err
		}
		conns = append(conns, conn)
	}
	return conns, nil
}
