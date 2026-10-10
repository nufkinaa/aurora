#!/usr/bin/env python3
"""Inclusive share of RenderThread samples whose stack contains a keyword (saveLayer, texture uploads, blur
mask filters, pinImages ...) - same input as tools/render-profile.py.   python tools/render-profile-kw.py samples.txt"""
import sys, re
from collections import Counter
path = sys.argv[1]
KW = ["drawShapeWithMaskFilter", "SkGpuBlurUtils", "GaussianBlur", "SkBlurMaskFilterImpl", "directFilterMaskGPU", "directFilterRRectMaskGPU",
      "sw_draw_with_mask_filter", "hw_create_filtered_mask", "SkMaskBlurFilter", "GrRRectBlurEffect", "make_unnormalized_half_kernel",
      "saveLayer", "internalSaveLayer", "SkImageFilter", "GrSoftwarePathRenderer", "writePixels", "uploadTexData", "texSubImage", "onUploadDeferredUpload", "GrOpFlushState::doUpload",
      "GrGLGpu::flushRenderTarget", "GrGLOpsRenderPass", "onBegin", "OpsTask::onExecute", "pinImages", "regenerateAtlas",
      "LayerDrawable", "renderLayersImpl", "drawTextBlob", "drawRRect", "drawDRRect", "drawPath", "clipPath", "onClipPath", "onClipRRect", "drawImageRect",
      "eglSwapBuffers", "dequeueBuffer", "queueBuffer", "prepareTree", "GrResourceAllocator", "GrGLGpu::ProgramCache::findOrCreateProgram", "GrGLProgramBuilder", "glCompileShader", "SkSL"]
tot = 0
inc = Counter()
leafdso = Counter()
cur = None
def flush(cur):
    global tot
    if not cur or cur["thread"] != "RenderThread": return
    tot += 1
    s = "\n".join(cur["chain"])
    for k in KW:
        if k in s: inc[k] += 1
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        s = line.strip()
        if s == "sample:":
            flush(cur); cur = {"thread": "", "chain": []}
        elif cur is not None:
            if s.startswith("thread_name:"): cur["thread"] = s[13:]
            elif s.startswith("symbol:"): cur["chain"].append(s[8:])
flush(cur)
print("RT samples", tot)
for k, v in inc.most_common():
    print("%6.2f%%  %s" % (100 * v / tot, k))
