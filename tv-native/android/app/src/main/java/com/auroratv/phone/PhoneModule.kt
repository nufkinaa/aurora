package com.auroratv.phone

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.MediaStore
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * "AuroraPhone" — what the phone app asks of its window and the device (src/phone/native.ts).
 * Registered only in the phone build (MainApplication: BuildConfig.PHONE); the TV never sees it.
 *
 *  - picture-in-picture: setPip(on, w, h) while a film plays (auto-enter on Android 12+,
 *    onUserLeaveHint before that), enterPip() on demand, `AuroraPip` {inPip} events;
 *  - the player's window: keepAwake, immersive (status + navigation bars hidden, a swipe from
 *    the edge shows them for a moment), brightness (this window only; -1 = the system's),
 *    orientation (auto / landscape / portrait);
 *  - the music stream's volume (the player's right-side swipe), and a haptic tick;
 *  - a photo for the profile (Settings → Upload a photo): pickAndUploadPhoto(url, headers) opens
 *    Android's photo picker, makes the picture smaller (longest side 1024, JPEG, under 2 MB) and
 *    POSTs it as the raw body itself — the server's JSON text back, null when the picker closed.
 */
class PhoneModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "AuroraPhone"

  init {
    current = WeakReference(this)
  }

  private val main = Handler(Looper.getMainLooper())

  private fun onUi(block: (Activity) -> Unit) {
    val act = ctx.currentActivity ?: activity?.get() ?: return
    main.post {
      try {
        block(act)
      } catch (_: Throwable) {}
    }
  }

  private fun audio() = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun getConstants(): MutableMap<String, Any> = hashMapOf(
      "sdk" to Build.VERSION.SDK_INT,
      "pipSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          ctx.packageManager.hasSystemFeature("android.software.picture_in_picture")),
  )

  // ---------------- picture-in-picture ----------------

  @ReactMethod
  fun setPip(on: Boolean, width: Double, height: Double) {
    pipWanted = on
    pipAspect = aspect(width, height)
    onUi { applyPipParams(it) }
  }

  @ReactMethod
  fun enterPip(promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    if (act == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.resolve(false)
      return
    }
    main.post {
      try {
        promise.resolve(act.enterPictureInPictureMode(params()))
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun isInPip(promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && act?.isInPictureInPictureMode == true)
  }

  // ---------------- the player's window ----------------

  @ReactMethod
  fun setKeepAwake(on: Boolean) = onUi {
    if (on) it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else it.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  @ReactMethod
  fun setImmersive(on: Boolean) = onUi {
    val c = WindowCompat.getInsetsController(it.window, it.window.decorView)
    if (on) {
      c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      c.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      c.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  /** 0..1 for this window, or a negative number for "whatever the system says". */
  @ReactMethod
  fun setBrightness(value: Double) = onUi {
    val lp = it.window.attributes
    lp.screenBrightness = if (value < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        else value.toFloat().coerceIn(0.01f, 1f)
    it.window.attributes = lp
  }

  /** This window's brightness, or the system's (0..1) when the window has not set one. */
  @ReactMethod
  fun getBrightness(promise: Promise) {
    val act = ctx.currentActivity
    val own = act?.window?.attributes?.screenBrightness ?: -1f
    if (own >= 0) {
      promise.resolve(own.toDouble())
      return
    }
    val sys = try {
      android.provider.Settings.System.getInt(ctx.contentResolver, android.provider.Settings.System.SCREEN_BRIGHTNESS)
    } catch (_: Throwable) {
      128
    }
    promise.resolve((sys / 255.0).coerceIn(0.0, 1.0))
  }

  /** "auto" (follow the phone, the person's rotation lock honoured), "landscape", "portrait". */
  @ReactMethod
  fun setOrientation(mode: String) = onUi {
    it.requestedOrientation = when (mode) {
      "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      else -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    }
  }

  @ReactMethod
  fun getVolume(promise: Promise) {
    val a = audio()
    val max = a.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    promise.resolve(a.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max)
  }

  /** 0..1 of the music stream; no system slider is shown (the player draws its own). */
  @ReactMethod
  fun setVolume(value: Double) {
    val a = audio()
    val max = a.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    val v = Math.round(value.coerceIn(0.0, 1.0) * max).toInt()
    try {
      a.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0)
    } catch (_: Throwable) {}
  }

  @ReactMethod
  fun haptic(kind: String) = onUi {
    val c = when (kind) {
      "long" -> HapticFeedbackConstants.LONG_PRESS
      "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      else -> if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.KEYBOARD_TAP else HapticFeedbackConstants.VIRTUAL_KEY
    }
    it.window.decorView.performHapticFeedback(c)
  }

  // ---------------- a photo for the profile ----------------
  // The website's "Upload a photo" (preferences.js pickPhoto → POST /api/profiles/:id/avatar-image
  // with the file as the body). There is no image picker library: the system's picker is
  // asked for one picture, which is read, turned upright, scaled and sent from here.

  private class PhotoRefused(message: String) : Exception(message)

  private var photoPromise: Promise? = null
  private var photoUrl = ""
  private var photoHeaders: Map<String, String> = emptyMap()

  private val photoListener = object : ActivityEventListener {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != PHOTO_REQUEST) return
      val p = photoPromise ?: return
      photoPromise = null
      val uri = if (resultCode == Activity.RESULT_OK) data?.data else null
      if (uri == null) {
        p.resolve(null) // closed without a picture
        return
      }
      val url = photoUrl
      val headers = photoHeaders
      Thread {
        try {
          p.resolve(uploadPhoto(url, headers, shrinkPhoto(uri)))
        } catch (e: PhotoRefused) {
          p.reject("E_PHOTO", e.message ?: "Upload failed")
        } catch (e: Throwable) {
          p.reject("E_PHOTO", "Couldn't read that picture — try another one.")
        }
      }.start()
    }

    override fun onNewIntent(intent: Intent) {}
  }

  init {
    ctx.addActivityEventListener(photoListener)
  }

  /** Pick one picture and POST it to `url` (with `headers`). Resolves the answer's text, null on cancel. */
  @ReactMethod
  fun pickAndUploadPhoto(url: String, headers: ReadableMap, promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    if (act == null) {
      promise.reject("E_PHOTO", "Aurora isn't on screen — open it and try again.")
      return
    }
    if (photoPromise != null) {
      promise.reject("E_PHOTO", "A photo is already being picked.")
      return
    }
    val h = HashMap<String, String>()
    val keys = headers.keySetIterator()
    while (keys.hasNextKey()) {
      val k = keys.nextKey()
      val v: String? = try { headers.getString(k) } catch (_: Throwable) { null }
      if (v != null) h[k] = v
    }
    photoUrl = url
    photoHeaders = h
    photoPromise = promise
    // Android 13+: the system photo picker (no permission needed); before it, any app that offers images
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
    } else {
      Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE)
    }
    main.post {
      try {
        act.startActivityForResult(intent, PHOTO_REQUEST)
      } catch (t: Throwable) {
        photoPromise = null
        promise.reject("E_PHOTO", "This phone has no app to pick a photo with.")
      }
    }
  }

  /** The picture upright, its longest side at most PHOTO_SIDE, as a JPEG under PHOTO_MAX bytes. */
  private fun shrinkPhoto(uri: Uri): ByteArray {
    var bmp = decodePhoto(uri, PHOTO_SIDE)
    var quality = 85
    while (true) {
      val out = ByteArrayOutputStream()
      bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
      val bytes = out.toByteArray()
      if (bytes.size <= PHOTO_MAX) return bytes
      if (quality > 55) {
        quality -= 10
      } else {
        val w = (bmp.width * 0.75).toInt()
        val hgt = (bmp.height * 0.75).toInt()
        if (w < 64 || hgt < 64) throw PhotoRefused("2MB max — pick a smaller image")
        bmp = Bitmap.createScaledBitmap(bmp, w, hgt, true)
      }
    }
  }

  private fun decodePhoto(uri: Uri, side: Int): Bitmap {
    val cr = ctx.contentResolver
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      // ImageDecoder turns the picture upright by itself, and reads HEIF as well
      val src = ImageDecoder.createSource(cr, uri)
      return ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
        val w = info.size.width
        val hgt = info.size.height
        val longest = maxOf(w, hgt)
        if (longest > side) {
          val k = side.toDouble() / longest
          decoder.setTargetSize((w * k).toInt().coerceAtLeast(1), (hgt * k).toInt().coerceAtLeast(1))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw PhotoRefused("That file isn't a JPEG, PNG or WebP.")
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= side) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    val raw = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
        ?: throw PhotoRefused("Couldn't read that picture — try another one.")
    val turn = try {
      cr.openInputStream(uri)?.use {
        when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90f
          ExifInterface.ORIENTATION_ROTATE_180 -> 180f
          ExifInterface.ORIENTATION_ROTATE_270 -> 270f
          else -> 0f
        }
      } ?: 0f
    } catch (_: Throwable) {
      0f
    }
    val longest = maxOf(raw.width, raw.height)
    val k = if (longest > side) side.toFloat() / longest else 1f
    if (turn == 0f && k == 1f) return raw
    val m = Matrix()
    m.postScale(k, k)
    m.postRotate(turn)
    return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
  }

  /** POST the JPEG as the raw body; the answer's text on 2xx, else the server's own refusal. */
  private fun uploadPhoto(url: String, headers: Map<String, String>, body: ByteArray): String {
    val c = try {
      URL(url).openConnection() as HttpURLConnection
    } catch (e: Throwable) {
      throw PhotoRefused("Couldn't reach the server — try again.")
    }
    try {
      c.requestMethod = "POST"
      c.doOutput = true
      c.useCaches = false
      c.connectTimeout = 15000
      c.readTimeout = 45000 // the server re-encodes it (ffmpeg, up to 20 s)
      c.setFixedLengthStreamingMode(body.size)
      for ((k, v) in headers) c.setRequestProperty(k, v)
      c.setRequestProperty("Content-Type", "image/jpeg")
      c.setRequestProperty("Accept", "application/json")
      c.outputStream.use { it.write(body) }
      val code = c.responseCode
      val stream = if (code in 200..299) c.inputStream else c.errorStream
      val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
      if (code in 200..299) return text
      val said = try {
        JSONObject(text).optString("error", "")
      } catch (_: Throwable) {
        ""
      }
      throw PhotoRefused(
          when {
            said.isNotEmpty() -> said
            code == 413 -> "2MB max — pick a smaller image"
            else -> "Upload failed ($code)"
          })
    } catch (e: PhotoRefused) {
      throw e
    } catch (e: IOException) {
      throw PhotoRefused("Couldn't reach the server — try again.")
    } finally {
      c.disconnect()
    }
  }

  // ---------------- [auth-round] Google sign-in in a Custom Tab ----------------
  //
  // src/phone/auth/google.ts. The app never sees Google's code or tokens: it opens
  // {server}/api/auth/google/app-start?intent=…&challenge=… in a Custom Tab, Google
  // sends the tab back to the server, the server sends it to
  // aurora-phone://auth/google?code=<one-time code>, and the app trades that code
  // AND the verifier only it holds (POST /api/auth/google/app-finish). The verifier
  // is made here: 32 bytes of SecureRandom, base64url without padding (43
  // characters); the challenge is base64url(SHA-256(verifier)) — RFC 7636's S256.

  @ReactMethod
  fun googlePkce(promise: Promise) {
    try {
      val bytes = ByteArray(32)
      java.security.SecureRandom().nextBytes(bytes)
      val flags = android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
      val verifier = android.util.Base64.encodeToString(bytes, flags)
      val digest = java.security.MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
      val m = Arguments.createMap()
      m.putString("verifier", verifier)
      m.putString("challenge", android.util.Base64.encodeToString(digest, flags))
      promise.resolve(m)
    } catch (t: Throwable) {
      promise.reject("pkce", t.message ?: "no secure random source", t)
    }
  }

  /**
   * Opens `url` in a Custom Tab (no androidx.browser: the same intent it builds, an
   * ACTION_VIEW with the session extra, which every Custom Tabs browser reads; a browser
   * without Custom Tabs simply opens the page). Resolves false when nothing on the phone
   * can open a web page — the caller then uses the code-on-screen way.
   */
  @ReactMethod
  fun openAuthTab(url: String, promise: Promise) {
    val act = ctx.currentActivity ?: activity?.get()
    main.post {
      try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        val extras = android.os.Bundle()
        // EXTRA_SESSION (null = no session): "this is a Custom Tab"
        extras.putBinder("android.support.customtabs.extra.SESSION", null)
        intent.putExtras(extras)
        // the app's own night ground behind the tab's toolbar, and its title shown
        intent.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFF070811.toInt())
        intent.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1)
        intent.putExtra("androidx.browser.customtabs.extra.COLOR_SCHEME", 2) // dark
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        // a browser that does Custom Tabs, by name when the default one does not
        val pm = ctx.packageManager
        val view = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")).addCategory(Intent.CATEGORY_BROWSABLE)
        val browsers = pm.queryIntentActivities(view, 0).map { it.activityInfo.packageName }.distinct()
        if (browsers.isEmpty()) {
          promise.resolve(false)
          return@post
        }
        val tabs = pm.queryIntentServices(Intent("android.support.customtabs.action.CustomTabsService"), 0)
            .map { it.serviceInfo.packageName }.toSet()
        val default = pm.resolveActivity(view, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
        val pick = when {
          default != null && tabs.contains(default) -> default
          else -> browsers.firstOrNull { tabs.contains(it) }
        }
        if (pick != null) intent.setPackage(pick)
        if (act != null) act.startActivity(intent)
        else ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        promise.resolve(true)
      } catch (e: android.content.ActivityNotFoundException) {
        promise.resolve(false)
      } catch (t: Throwable) {
        promise.resolve(false)
      }
    }
  }

  // RN's NativeEventEmitter wants these two on Android
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") name: String) {}
  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  private fun emitPip(inPip: Boolean) {
    try {
      val m = Arguments.createMap()
      m.putBoolean("inPip", inPip)
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AuroraPip", m)
    } catch (_: Throwable) {}
  }

  companion object {
    private var current: WeakReference<PhoneModule>? = null
    private var activity: WeakReference<Activity>? = null
    @Volatile private var pipWanted = false
    @Volatile private var pipAspect: Rational = Rational(16, 9)
    private const val PHOTO_REQUEST = 0x5A71 // the photo picker's answer (VoiceModule's is 4711)
    private const val PHOTO_SIDE = 1024 // the server keeps a 256 px square; this leaves it room to crop
    private const val PHOTO_MAX = 2_000_000 // under the route's 2 MB raw-body limit (2 097 152)

    /** PiP's limits are 1:2.39 .. 2.39:1; anything else is clamped into them. */
    private fun aspect(w: Double, h: Double): Rational {
      if (!(w > 0 && h > 0)) return Rational(16, 9)
      val r = (w / h).coerceIn(1 / 2.39 + 0.001, 2.39 - 0.001)
      return Rational((r * 1000).toInt(), 1000)
    }

    private fun params(): PictureInPictureParams {
      val b = PictureInPictureParams.Builder().setAspectRatio(pipAspect)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        b.setAutoEnterEnabled(pipWanted)
        b.setSeamlessResizeEnabled(true)
      }
      return b.build()
    }

    private fun applyPipParams(act: Activity) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        act.setPictureInPictureParams(params())
      } catch (_: Throwable) {}
    }

    fun attach(act: Activity) {
      activity = WeakReference(act)
    }

    fun detach(act: Activity) {
      if (activity?.get() === act) activity = null
    }

    /** Android 8–11: no auto-enter, so going Home while a film plays enters PiP here. */
    fun onUserLeaveHint(act: Activity) {
      if (!pipWanted || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
      try {
        act.enterPictureInPictureMode(params())
      } catch (_: Throwable) {}
    }

    fun onPipChanged(inPip: Boolean) {
      current?.get()?.emitPip(inPip)
    }
  }
}
