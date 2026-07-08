package tray

import (
	"bytes"
	"encoding/binary"
)

// The tray icons are generated as 32x32 ICO images at runtime so the app needs
// no external asset files. A filled disc in an accent colour reads clearly in
// the Windows notification area; the colour encodes connection state.
const iconSize = 32

var (
	colorConnected  = rgb(0x7C, 0x5C, 0xFC) // Bifrost violet
	colorConnecting = rgb(0xF5, 0xA6, 0x23) // amber
	colorIdle       = rgb(0x6B, 0x72, 0x80) // muted gray
	colorError      = rgb(0xE5, 0x48, 0x4A) // red
)

type rgbColor struct{ r, g, b uint8 }

func rgb(r, g, b uint8) rgbColor { return rgbColor{r, g, b} }

// iconConnected/etc. return ICO bytes for each state.
func iconConnected() []byte  { return buildICO(colorConnected) }
func iconConnecting() []byte { return buildICO(colorConnecting) }
func iconIdle() []byte       { return buildICO(colorIdle) }
func iconError() []byte      { return buildICO(colorError) }

// buildICO produces a 32x32 32-bpp ICO with a filled anti-aliased disc.
func buildICO(c rgbColor) []byte {
	const n = iconSize
	xor := make([]byte, 0, n*n*4)

	// Bottom-up rows (BMP convention), BGRA per pixel.
	cx, cy := float64(n)/2-0.5, float64(n)/2-0.5
	radius := float64(n)/2 - 2
	for y := n - 1; y >= 0; y-- {
		for x := 0; x < n; x++ {
			alpha := coverage(float64(x), float64(y), cx, cy, radius)
			if alpha == 0 {
				xor = append(xor, 0, 0, 0, 0)
				continue
			}
			// Pre-nothing: straight alpha, BGRA order.
			xor = append(xor, c.b, c.g, c.r, alpha)
		}
	}

	// AND mask: one bit per pixel, padded to 32-bit rows. All zero — the alpha
	// channel drives transparency.
	andRowBytes := ((n + 31) / 32) * 4
	andMask := make([]byte, andRowBytes*n)

	var buf bytes.Buffer
	le := func(v any) { _ = binary.Write(&buf, binary.LittleEndian, v) }

	imageBytes := 40 + len(xor) + len(andMask)

	// ICONDIR
	le(uint16(0)) // reserved
	le(uint16(1)) // type: icon
	le(uint16(1)) // count

	// ICONDIRENTRY
	buf.WriteByte(n) // width
	buf.WriteByte(n) // height
	buf.WriteByte(0) // colours in palette
	buf.WriteByte(0) // reserved
	le(uint16(1))    // colour planes
	le(uint16(32))   // bits per pixel
	le(uint32(imageBytes))
	le(uint32(22)) // offset (6 + 16)

	// BITMAPINFOHEADER
	le(uint32(40))     // biSize
	le(int32(n))       // biWidth
	le(int32(n * 2))   // biHeight (XOR + AND)
	le(uint16(1))      // biPlanes
	le(uint16(32))     // biBitCount
	le(uint32(0))      // biCompression BI_RGB
	le(uint32(len(xor)))
	le(int32(0))       // biXPelsPerMeter
	le(int32(0))       // biYPelsPerMeter
	le(uint32(0))      // biClrUsed
	le(uint32(0))      // biClrImportant

	buf.Write(xor)
	buf.Write(andMask)
	return buf.Bytes()
}

// coverage returns an 8-bit alpha for a pixel based on its distance to the disc
// edge, giving a lightly anti-aliased circle.
func coverage(x, y, cx, cy, radius float64) uint8 {
	dx, dy := x-cx, y-cy
	dist := sqrt(dx*dx + dy*dy)
	edge := radius - dist
	switch {
	case edge >= 1:
		return 255
	case edge <= 0:
		return 0
	default:
		return uint8(edge * 255)
	}
}

// sqrt is a tiny Newton's-method square root to avoid importing math for a
// single call site.
func sqrt(v float64) float64 {
	if v <= 0 {
		return 0
	}
	z := v
	for i := 0; i < 20; i++ {
		z = z - (z*z-v)/(2*z)
	}
	return z
}
