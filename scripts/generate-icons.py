"""生成 Electron 图标资源（需要 Python 3 和 Pillow，不参与应用构建）。

首次导入：python3 scripts/generate-icons.py /path/to/image.png --remove-background
重新导出：python3 scripts/generate-icons.py
"""

import argparse
from collections import deque
from io import BytesIO
from pathlib import Path
import struct

from PIL import Image


ICNS_SIZES = {
    b"icp4": 16,
    b"icp5": 32,
    b"icp6": 64,
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic10": 1024,
    b"ic11": 32,
    b"ic12": 64,
    b"ic13": 256,
    b"ic14": 512,
}
ICO_SIZES = [(size, size) for size in (16, 24, 32, 48, 64, 128, 256)]


def remove_background(image):
    """只移除与画布边缘连通的浅灰背景，保留章鱼内部的白色。"""
    width, height = image.size
    pixels = image.load()
    visited = set()
    pending = deque()
    for x in range(width):
        pending.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        pending.extend(((0, y), (width - 1, y)))
    while pending:
        x, y = pending.popleft()
        if (x, y) in visited:
            continue
        visited.add((x, y))
        red, green, blue, alpha = pixels[x, y]
        if alpha and (min(red, green, blue) < 160 or max(red, green, blue) - min(red, green, blue) > 40):
            continue
        pixels[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                pending.append((nx, ny))
    return image


def main():
    directory = Path(__file__).resolve().parents[1] / "assets" / "icons"
    parser = argparse.ArgumentParser(description="导出 Octo Fetch 的 PNG、ICNS 和 ICO 图标")
    parser.add_argument("source", nargs="?", type=Path, default=directory / "icon.png")
    parser.add_argument("--remove-background", action="store_true", help="移除生成图的浅灰色外部背景")
    args = parser.parse_args()
    with Image.open(args.source) as source:
        image = source.convert("RGBA")
    if image.width != image.height or image.width < 1024:
        parser.error("源图必须为至少 1024 × 1024 的正方形")
    if args.remove_background:
        image = remove_background(image)
    image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
    directory.mkdir(parents=True, exist_ok=True)
    image.save(directory / "icon.png", optimize=True)
    image.save(directory / "icon.ico", sizes=ICO_SIZES, bitmap_format="png")

    # ICNS 同时包含标准尺寸和 Retina 表示，所有条目均使用无损 PNG。
    representations = {}
    for size in set(ICNS_SIZES.values()):
        stream = BytesIO()
        image.resize((size, size), Image.Resampling.LANCZOS).save(stream, format="PNG", optimize=True)
        representations[size] = stream.getvalue()
    chunks = []
    for kind, size in ICNS_SIZES.items():
        png = representations[size]
        chunks.append(kind + struct.pack(">I", len(png) + 8) + png)
    payload = b"".join(chunks)
    (directory / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)
    print(f"已生成图标：{directory}（PNG 1024 px，ICNS 16–1024 px，ICO 16–256 px）")


if __name__ == "__main__":
    main()
