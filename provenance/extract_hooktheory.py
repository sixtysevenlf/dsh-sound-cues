"""从 Hooktheory 页面里把嵌入式旋律数据抠出来。

Hooktheory 的 TheoryTab 页把整首歌的分析（和弦 + 旋律，以**音级**表示）
以 Next.js flight 数据的形式内联在 HTML 里。这里做两件事：
  1. 找出包含 scaleDegrees/chords 的那段内联 JSON；
  2. 反转义后尽力解析，打印结构。
"""
import json
import os
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("TEMP", ""), "ht.html")
h = open(path, encoding="utf-8", errors="replace").read()
print("html length", len(h))

for key in ["scaleDegrees", "chords", "melody", "pitchMinMidi", "beatsPerNote"]:
    print(f"{key}: {h.count(key)} occurrences")

i = h.find("scaleDegrees")
print("\n=== first scaleDegrees at", i, "===")
if i < 0:
    sys.exit(0)

chunk = h[max(0, i - 4000) : i + 9000]
# Next.js flight 会把 JSON 二次转义
un = chunk.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
print(un)
open(os.path.join(os.path.dirname(path), "ht-chunk.txt"), "w", encoding="utf-8").write(un)
print("\n[written ht-chunk.txt]")
