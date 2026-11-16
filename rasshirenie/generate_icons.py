import struct
import zlib

def create_png(width, height, pixels):
    """Create a PNG file from raw RGBA pixel data."""
    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xffffffff
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', crc)
    
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'
    
    # IHDR
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    
    # IDAT - raw pixel data with filter byte per row
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter: none
        for x in range(width):
            idx = (y * width + x) * 4
            raw += pixels[idx:idx+4]
    
    idat = zlib.compress(raw)
    
    # IEND
    iend = b''
    
    return sig + make_chunk(b'IHDR', ihdr) + make_chunk(b'IDAT', idat) + make_chunk(b'IEND', iend)

def make_icon(size):
    """Create a simple FP icon with golden background."""
    pixels = bytearray()
    for y in range(size):
        for x in range(size):
            # Background: dark navy gradient
            t = y / size
            r = int(26 + (22 - 26) * t)
            g = int(26 + (33 - 26) * t)
            b = int(46 + (62 - 46) * t)
            
            # Draw rounded rectangle background
            margin = size // 8
            corner = size // 5
            
            # Check if inside rounded rect
            in_x = margin <= x < size - margin
            in_y = margin <= y < size - margin
            
            if in_x and in_y:
                # Check corners
                in_corner = True
                # Top-left
                if x < margin + corner and y < margin + corner:
                    dx = margin + corner - x
                    dy = margin + corner - y
                    if dx*dx + dy*dy > corner*corner:
                        in_corner = False
                # Top-right
                elif x >= size - margin - corner and y < margin + corner:
                    dx = x - (size - margin - corner - 1)
                    dy = margin + corner - y
                    if dx*dx + dy*dy > corner*corner:
                        in_corner = False
                # Bottom-left
                elif x < margin + corner and y >= size - margin - corner:
                    dx = margin + corner - x
                    dy = y - (size - margin - corner - 1)
                    if dx*dx + dy*dy > corner*corner:
                        in_corner = False
                # Bottom-right
                elif x >= size - margin - corner and y >= size - margin - corner:
                    dx = x - (size - margin - corner - 1)
                    dy = y - (size - margin - corner - 1)
                    if dx*dx + dy*dy > corner*corner:
                        in_corner = False
                
                if in_corner:
                    # Golden gradient background
                    r2 = int(232 - (232 - 212) * t)
                    g2 = int(179 - (179 - 149) * t)
                    b2 = int(57 - (57 - 36) * t)
                    
                    # Draw "FP" letters
                    cx = size / 2
                    cy = size / 2
                    
                    # Simple letter F
                    f_x_start = int(size * 0.28)
                    f_x_end = int(size * 0.45)
                    f_y_start = int(size * 0.25)
                    f_y_end = int(size * 0.75)
                    f_mid_y = int(size * 0.40)
                    f_mid_y2 = int(size * 0.50)
                    
                    # Letter P
                    p_x_start = int(size * 0.52)
                    p_x_end = int(size * 0.72)
                    p_y_start = int(size * 0.25)
                    p_y_end = int(size * 0.75)
                    p_mid_y = int(size * 0.42)
                    
                    is_letter = False
                    
                    # F vertical bar
                    if f_x_start <= x < f_x_start + max(1, size//12) and f_y_start <= y < f_y_end:
                        is_letter = True
                    # F top horizontal
                    if f_x_start <= x < f_x_end and f_y_start <= y < f_y_start + max(1, size//12):
                        is_letter = True
                    # F middle horizontal
                    if f_x_start <= x < f_x_end - size//10 and f_mid_y2 <= y < f_mid_y2 + max(1, size//14):
                        is_letter = True
                    
                    # P vertical bar
                    if p_x_start <= x < p_x_start + max(1, size//12) and p_y_start <= y < p_y_end:
                        is_letter = True
                    # P top horizontal
                    if p_x_start <= x < p_x_end and p_y_start <= y < p_y_start + max(1, size//12):
                        is_letter = True
                    # P right curve (simplified)
                    if p_x_end - max(1, size//12) <= x < p_x_end and p_y_start <= y < p_mid_y + max(1, size//12):
                        is_letter = True
                    # P bottom of loop
                    if p_x_start <= x < p_x_end and p_mid_y <= y < p_mid_y + max(1, size//12):
                        is_letter = True
                    
                    if is_letter:
                        pixels.extend([26, 26, 46, 255])  # Dark text
                    else:
                        pixels.extend([r2, g2, b2, 255])  # Gold background
                else:
                    pixels.extend([26, 26, 46, 255])  # Outside rounded rect = dark
            else:
                pixels.extend([0, 0, 0, 0])  # Transparent
    
    return bytes(pixels)

import os
icon_dir = r"C:/Users/user/WorkBuddy AI/rasshirenie/icons"
os.makedirs(icon_dir, exist_ok=True)

for size in [16, 48, 128]:
    pixels = make_icon(size)
    png = create_png(size, size, pixels)
    path = os.path.join(icon_dir, f"icon{size}.png")
    with open(path, 'wb') as f:
        f.write(png)
    print(f"Created {path} ({len(png)} bytes)")

print("Done!")
