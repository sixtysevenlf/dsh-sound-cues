import struct, collections, sys

path = r"D:\DSH\work\sound-plugin-ref\champions.mid"
data = open(path, "rb").read()
hlen = struct.unpack(">I", data[4:8])[0]
fmt, ntrk, div = struct.unpack(">HHH", data[8:14])
pos = 8 + hlen
ln = struct.unpack(">I", data[pos+4:pos+8])[0]
body = data[pos+8:pos+8+ln]

def read_varlen(b, i):
    v = 0
    while True:
        c = b[i]; i += 1
        v = (v << 7) | (c & 0x7F)
        if not (c & 0x80): return v, i

i = 0; t = 0; running = None; ev = []
while i < len(body):
    d, i = read_varlen(body, i); t += d
    st = body[i]
    if st < 0x80: st = running
    else: i += 1
    if st is None: break
    if st == 0xFF:
        running = None; mt = body[i]; i += 1
        l2, i = read_varlen(body, i); pl = body[i:i+l2]; i += l2
        ev.append((t, "meta", mt, pl, None))
    elif st in (0xF0, 0xF7):
        running = None; l2, i = read_varlen(body, i); i += l2
    else:
        running = st; hi = st & 0xF0; ch = st & 0x0F
        if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
            a = body[i]; b = body[i+1]; i += 2
            ev.append((t, hi, ch, a, b))
        elif hi in (0xC0, 0xD0):
            a = body[i]; i += 1; ev.append((t, hi, ch, a, None))

target = int(sys.argv[1]) if len(sys.argv) > 1 else 3
pend = collections.defaultdict(list); out = []
for e in ev:
    if e[1] == 0x90 and e[4] > 0 and e[2] == target:
        pend[e[3]].append(e[0])
    elif (e[1] == 0x80 or (e[1] == 0x90 and e[4] == 0)) and e[2] == target:
        if pend[e[3]]:
            out.append((pend[e[3]].pop(0), e[0], e[3]))
out.sort()

# tempo map
tempos = [(0, 500000)]
for e in ev:
    if e[1] == "meta" and e[2] == 0x51:
        tempos.append((e[0], struct.unpack(">I", b"\x00" + e[3])[0]))
tempos.sort()

def sec(tick):
    t = 0.0; prev = 0; cur = 500000
    for tt, us in tempos:
        if tt >= tick: break
        t += (tt - prev) / div * (cur / 1e6)
        prev = tt; cur = us
    t += (tick - prev) / div * (cur / 1e6)
    return t

names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
print(f"channel {target}: {len(out)} notes")
prev_beat = None
for s, e, p in out:
    beat = s / div
    dur = (e - s) / div
    gap = "" if prev_beat is None else f"+{beat-prev_beat:.2f}"
    print(f"{sec(s):7.2f}s  beat{beat:7.2f} {names[p%12]:>2}{p//12-1:<2} dur{dur:5.2f} {gap}")
    prev_beat = beat
