package com.auroratv.ui.art

import android.content.Context
import android.util.Log
import java.io.File

/**
 * LAB — the art-format experiment's two switches (docs/qa/native-bench/ART-FORMAT-PLAN.md),
 * both OFF unless adb turned them on. Read ONCE per process, before Fresco is configured
 * and before any JS runs, so a change takes effect on the next launch.
 *
 *  - `webp`:  the home hero's blurred pictures are asked for as WebP (`&fmt=webp`) and the
 *             title page's backdrop goes through the server (`/img/ext?u=…&w=…`) instead of
 *             the catalogue's original JPEG. JS reads it from the AuroraArt module
 *             (src/artFormat.ts); nothing native changes what it draws.
 *  - `probe`: ArtProbe logs Fresco's fetch size and decode time for those pictures to
 *             logcat tag `AuroraArt`. Independent of `webp`, so the JPEG baseline is
 *             measured by the same code.
 *  - `server`: an address tried BEFORE the app's own server list (api.ts), for a lab
 *             server on another port than the real one. Empty = the list as it is.
 *
 * A switch is ON when a marker file exists in the app's external files dir —
 *
 *     adb shell touch /sdcard/Android/data/com.auroratv.lab/files/art-webp
 *     adb shell touch /sdcard/Android/data/com.auroratv.lab/files/art-probe
 *     adb shell rm -f /sdcard/Android/data/com.auroratv.lab/files/art-webp      (off again)
 *     adb shell "echo http://192.168.50.108:4100 > /sdcard/Android/data/com.auroratv.lab/files/art-server"
 *
 * — or, as a fallback where the shell may not write there, when the debug property is 1
 * (`adb shell setprop debug.aurora.artwebp 1` / `debug.aurora.artprobe 1`, and
 * `debug.aurora.artserver <url>`; gone at reboot).
 * Files rather than a broadcast: no receiver, no manifest entry, nothing in the shared
 * QA plumbing — and the state survives a force-stop, which a cold-start measurement needs.
 */
object ArtFormat {
  const val TAG = "AuroraArt"

  @Volatile var webp = false
    private set

  @Volatile var probe = false
    private set

  @Volatile var server = ""
    private set

  @Volatile private var loaded = false

  @Synchronized
  fun load(ctx: Context) {
    if (loaded) return
    loaded = true
    val dir = try { ctx.applicationContext.getExternalFilesDir(null) } catch (_: Throwable) { null }
    webp = on(dir, "art-webp", "debug.aurora.artwebp")
    probe = on(dir, "art-probe", "debug.aurora.artprobe")
    server = serverOf(dir)
    // one line per launch, so a run's logcat says which arm it was
    Log.i(TAG, "flags webp=${if (webp) 1 else 0} probe=${if (probe) 1 else 0} server=${server.ifEmpty { "-" }} dir=$dir")
  }

  private fun on(dir: File?, marker: String, prop: String): Boolean {
    try {
      if (dir != null && File(dir, marker).exists()) return true
    } catch (_: Throwable) {}
    return sysprop(prop) == "1"
  }

  private val URL = Regex("^https?://[A-Za-z0-9.:\\-]+$")

  /** The art-server marker's first line (or the debug property), if it is a plain http(s) origin. */
  private fun serverOf(dir: File?): String {
    val fromFile =
      try {
        val f = if (dir != null) File(dir, "art-server") else null
        if (f != null && f.exists()) f.readLines().firstOrNull()?.trim() ?: "" else ""
      } catch (_: Throwable) {
        ""
      }
    val v = fromFile.ifEmpty { sysprop("debug.aurora.artserver").trim() }
    return if (URL.matches(v)) v else ""
  }

  private fun sysprop(key: String): String =
    try {
      Class.forName("android.os.SystemProperties")
        .getMethod("get", String::class.java)
        .invoke(null, key) as? String ?: ""
    } catch (_: Throwable) {
      ""
    }
}
