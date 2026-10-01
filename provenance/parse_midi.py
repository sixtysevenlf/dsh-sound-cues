import struct, sys, json, collections

path = r"D:\DSH\work\sound-plugin-ref\champions.mid"
data = open(path, "rb").read()
assert data[:4] == b"MThd", data[:4]
hlen = struct.unpack(">I", data[4:8])[0]
fmt, ntrk, div = struct.unpack(">HHH", data[8:14])
print("format", fmt, "tracks", ntrk, "division", div)

pos = 8 + hlen
tracks = []
for t in range(ntrk):
    assert data[pos:pos+4] == b"MTrk", (t, data[pos:pos+4])
    ln = struct.unpack(">I", data[pos+4:pos+8])[0]
    body = data[pos+8:pos+8+ln]
    pos += 8 + ln
    tracks.append(body)

def read_varlen(b, i):
    v = 0
    while True:
        c = b[i]; i += 1
        v = (v << 7) | (c & 0x7F)
        if not (c & 0x80):
            return v, i

def parse(body):
    i = 0; t = 0; running = None
    events = []
    while i < len(body):
        d, i = read_varlen(body, i)
        t += d
        st = body[i]
        if st < 0x80:
            st = running
        else:
            i += 1
        if st is None: break
        if st == 0xFF:
            running = None
            mt = body[i]; i += 1
            ln, i = read_varlen(body, i)
            payload = body[i:i+ln]; i += ln
            events.append((t, "meta", mt, payload))
        elif st in (0xF0, 0xF7):
            running = None
            ln, i = read_varlen(body, i); i += ln
        else:
            running = st
            hi = st & 0xF0; ch = st & 0x0F
            if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                a = body[i]; b = body[i+1]; i += 2
                events.append((t, hi, ch, a, b))
            elif hi in (0xC0, 0xD0):
                a = body[i]; i += 1
                events.append((t, hi, ch, a))
    return events

allnotes = []
for ti, body in enumerate(tracks):
    ev = parse(body)
    name = ""
    tempo = None
    notes = {}
    out = []
    for e in ev:
        if e[1] == "meta":
            if e[2] == 0x03: name = e[3].decode("latin1", "replace")
            if e[2] == 0x51: tempo = struct.unpack(">I", b"\x00" + e[3])[0]
        elif e[1] == 0x90 and e[4] > 0:
            notes.setdefault((e[2], e[3]), []).append(e[0])
        elif e[1] == 0x80 or (e[1] == 0x90 and e[4] == 0):
            k = (e[2], e[3])
            if k in notes and notes[k]:
                st = notes[k].pop(0)
                out.append((st, e[0], e[3]))
        elif e[1] == 0x90:
            pass
    out.sort()
    if out:
        lo = min(n[2] for n in out); hi = max(n[2] for n in out)
        mono = 0
        active = []
        for s, e, p in out:
            active = [x for x in active if x[1] > s]
            if active: mono += 1
            active.append((s, e, p))
        print(f"track {ti}: name={name!r} notes={len(out)} range={lo}-{hi} overlaps={mono} tempo={tempo}")
        allnotes.append((ti, name, out, div))

# print the most monophonic, high-range track as candidate melody
import statistics
best = None
for ti, name, out, div in allnotes:
    hi = max(n[2] for n in out); lo = min(n[2] for n in out)
    score = (1 if hi >= 67 else 0) - 0
    if best is None or len(out) > len(best[2]):
        pass
print()
print("=== per-track first 40 notes (sorted) ===")
for ti, name, out, div in allnotes:
    print(f"--- track {ti} {name!r} ---")
    print(" ".join(f"{p}@{s/div:.2f}" for s, e, p in out[:60]))
