import sys
from PIL import Image
src, dst, x, y, w, h, k = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:8])
Image.open(src).crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.LANCZOS).save(dst)
