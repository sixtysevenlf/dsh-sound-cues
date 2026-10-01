"""
从 MIDI 里定位并抽取某条旋律线。

用法：
  python analyze_midi.py <file.mid> channels          # 列出各通道概况
  python analyze_midi.py <file.mid> dump <ch>         # 转储某通道（音高+时长+秒）
  python analyze_midi.py <file.mid> find <a,b,c,...>  # 按音高轮廓模板搜索（半音间隔序列）
  python analyze_midi.py <file.mid> midi <ch>         # 以 MIDI 音符号输出序列（便于写进代码）

模板用**音程**（相邻音的半音差）表示，忽略绝对音高，这样与调性无关。
"""
import struct
import sys
import collections

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def load(path):
    data = open(path, "rb").read()
    assert data[:4] == b"MThd", "not a MIDI"
    hlen = struct.unpack(">I", data[4:8])[0]
    fmt, ntrk, div = struct.unpack(">HHH", data[8:14])
    pos = 8 + hlen
    bodies = []
    for _ in range(ntrk):
        ln = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        bodies.append(data[pos + 8 : pos + 8 + ln])
        pos += 8 + ln
    return data, fmt, ntrk, div, bodies


def read_varlen(b, i):
    v = 0
    while True:
        c = b[i]
        i += 1
        v = (v << 7) | (c & 0x7F)
        if not (c & 0x80):
            return v, i


def parse(body):
    i = 0
    t = 0
    running = None
    ev = []
    while i < len(body):
        d, i = read_varlen(body, i)
        t += d
        st = body[i]
        if st < 0x80:
            st = running
        else:
            i += 1
        if st is None:
            break
        if st == 0xFF:
            running = None
            mt = body[i]
            i += 1
            ln, i = read_varlen(body, i)
            pl = body[i : i + ln]
            i += ln
            ev.append((t, "meta", mt, pl))
        elif st in (0xF0, 0xF7):
            running = None
            ln, i = read_varlen(body, i)
            i += ln
        else:
            running = st
            hi = st & 0xF0
            ch = st & 0x0F
            if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                a = body[i]
                b = body[i + 1]
                i += 2
                ev.append((t, hi, ch, a, b))
            elif hi in (0xC0, 0xD0):
                a = body[i]
                i += 1
                ev.append((t, hi, ch, a))
    return ev


def collect(ev, target=None):
    """返回 {channel: [(start_tick, end_tick, pitch)]}"""
    chans = collections.defaultdict(list)
    pend = collections.defaultdict(list)
    for e in ev:
        if e[1] == 0x90 and e[4] > 0:
            pend[(e[2], e[3])].append(e[0])
        elif e[1] == 0x80 or (e[1] == 0x90 and e[4] == 0):
            k = (e[2], e[3])
            if pend[k]:
                chans[e[2]].append((pend[k].pop(0), e[0], e[3]))
    for c in chans:
        chans[c].sort()
    return chans


def tempo_map(ev, div):
    tempos = [(0, 500000)]
    for e in ev:
        if e[1] == "meta" and e[2] == 0x51:
            tempos.append((e[0], struct.unpack(">I", b"\x00" + e[3])[0]))
    tempos.sort()

    def sec(tick):
        t = 0.0
        prev = 0
        cur = 500000
        for tt, us in tempos:
            if tt >= tick:
                break
            t += (tt - prev) / div * (cur / 1e6)
            prev = tt
            cur = us
        t += (tick - prev) / div * (cur / 1e6)
        return t

    return sec


def main():
    path = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "channels"
    data, fmt, ntrk, div, bodies = load(path)
    ev = []
    for b in bodies:
        ev.extend(parse(b))
    chans = collect(ev)
    sec = tempo_map(ev, div)

    if mode == "channels":
        print(f"format={fmt} tracks={ntrk} division={div}")
        progs = collections.defaultdict(set)
        for e in ev:
            if e[1] == 0xC0:
                progs[e[2]].add(e[3])
        for c in sorted(chans):
            n = chans[c]
            lo = min(x[2] for x in n)
            hi = max(x[2] for x in n)
            span = sec(max(x[1] for x in n))
            print(
                f"  ch{c:2d}: notes={len(n):5d} range={lo:3d}-{hi:3d} "
                f"({NAMES[lo%12]}{lo//12-1}..{NAMES[hi%12]}{hi//12-1}) "
                f"prog={sorted(progs.get(c, []))} span={span:.1f}s"
            )
        return

    ch = int(sys.argv[3])
    notes = chans[ch]
    if mode == "dump":
        print(f"channel {ch}: {len(notes)} notes")
        prev = None
        for s, e, p in notes:
            beat = s / div
            gap = "" if prev is None else f"+{beat-prev:.2f}"
            print(f"{sec(s):7.2f}s beat{beat:7.2f} {NAMES[p%12]:>2}{p//12-1:<2} dur{(e-s)/div:5.2f} {gap}")
            prev = beat
        return

    if mode == "midi":
        print("[")
        print(",\n".join(f"  [{p}, {s/div:.2f}, {(e-s)/div:.2f}]" for s, e, p in notes))
        print("]")
        return

    if mode == "find":
        # 模板：绝对音高列表 -> 半音间隔
        tpl = [int(x) for x in sys.argv[3].split(",")]
        tpl_int = [tpl[i + 1] - tpl[i] for i in range(len(tpl) - 1)]
        print(f"模板音程 {tpl_int}")
        for c in sorted(chans):
            seq = [(s, p) for s, e, p in chans[c]]
            # 只看音头间隔合理的连续段
            hits = []
            for i in range(len(seq) - len(tpl) + 1):
                win = seq[i : i + len(tpl)]
                ok = True
                for k in range(len(tpl_int)):
                    d = win[k + 1][1] - win[k][1]
                    if abs(d - tpl_int[k]) > 0:
                        ok = False
                        break
                    if win[k + 1][0] - win[k][0] > div * 2.5:
                        ok = False
                        break
                if ok:
                    hits.append(sec(win[0][0]))
            if hits:
                print(f"  ch{c}: {len(hits)} 处命中 @ " + ", ".join(f"{h:.1f}s" for h in hits[:12]))
        return


main()
