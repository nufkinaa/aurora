"""RETIRED - do not bring this back.

This script used to draw the launcher icons (mipmap-*/ic_launcher*.png), the Android TV banner (drawable/banner.png) and src/assets/logo.png
from the old logo: a violet conic-gradient square (with a typed "A" on the launcher).

Aurora's logo is now Beam, and every one of those files is generated from the brand
sources instead:

    python docs/brand/tools/build.py install        (from the repo root)

See docs/brand/README.md. The body of this script was removed on purpose, so that
running it can never overwrite the new logo with the old one. The old code is in git
history (last present in 3d72eaf).
"""
raise SystemExit(__doc__)
