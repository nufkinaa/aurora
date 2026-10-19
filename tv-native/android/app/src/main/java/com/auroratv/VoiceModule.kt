package com.auroratv

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale

/**
 * AuroraVoice: voice search with the remote's microphone (tv-native/src/voice.ts drives it;
 * src/voiceLogic.ts has the rules, shared with the website).
 *
 * Two ways to hear, because TVs differ (docs/qa/voice-search/REPORT.md has the device checks):
 *
 *  1. SpeechRecognizer — Android's recognition SERVICE (on Android TV the Google app,
 *     com.google.android.katniss). Aurora draws its own panel and the words appear in the
 *     search field AS THEY ARE SAID (partial results). Needs RECORD_AUDIO, asked by the JS side
 *     (PermissionsAndroid) before start().
 *  2. RecognizerIntent — the system's own voice overlay (startActivityForResult), for a TV whose
 *     recognition service will not serve another app. No partial words, one final answer;
 *     the overlay has its own microphone permission.
 *
 * Events, all as "AuroraVoice" { session, type, text?, code?, level? }:
 *   ready · begin · level (0..1, at most ~8 a second) · partial · final · error (code: Android's
 *   SpeechRecognizer.ERROR_* number, or "cancelled" / "unavailable" / "intent") · end
 * `session` is the caller's number for one listening; whatever arrives for an older one is the
 * caller's to drop.
 *
 * The remote's own search / voice key: MainActivity hands KEYCODE_SEARCH and
 * KEYCODE_VOICE_ASSIST here while JS has asked for them (captureKeys(true)), as "AuroraVoiceKey".
 * Android itself may keep a key (most TVs give the Assistant button to the Assistant, before any
 * app sees it): then the on-screen mic is the way in.
 */
class VoiceModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), ActivityEventListener {

  override fun getName() = "AuroraVoice"

  private var recognizer: SpeechRecognizer? = null
  private var session = 0
  private var intentSession = -1
  private var lastLevelAt = 0L

  init {
    ctx.addActivityEventListener(this)
    current = this
  }

  override fun invalidate() {
    if (current === this) current = null
    keysWanted = false
    UiThreadUtil.runOnUiThread { destroyRecognizer() }
    super.invalidate()
  }

  // ------------------------------------------------------------------ what the TV has

  /** { recognizer, intent, services: [package], permission, locale, onDevice } */
  @ReactMethod
  fun availability(promise: Promise) {
    try {
      val pm = ctx.packageManager
      val map = Arguments.createMap()
      map.putBoolean("recognizer", SpeechRecognizer.isRecognitionAvailable(ctx))
      val services = Arguments.createArray()
      try {
        for (r in pm.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)) {
          services.pushString("${r.serviceInfo.packageName}/${r.serviceInfo.name}")
        }
      } catch (_: Exception) {}
      map.putArray("services", services)
      val activities = try {
        pm.queryIntentActivities(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0)
      } catch (_: Exception) {
        emptyList()
      }
      map.putBoolean("intent", activities.isNotEmpty())
      map.putBoolean(
        "permission",
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
      )
      map.putString("locale", Locale.getDefault().toLanguageTag())
      map.putBoolean(
        "onDevice",
        Build.VERSION.SDK_INT >= 31 && try { SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx) } catch (_: Throwable) { false },
      )
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("voice", e.message, e)
    }
  }

  // --------------------------------------------------------------- 1. the service

  @ReactMethod
  fun start(lang: String, sessionId: Double) {
    val id = sessionId.toInt()
    UiThreadUtil.runOnUiThread {
      destroyRecognizer()
      session = id
      if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
        emit(id, "error") { it.putString("code", "unavailable") }
        return@runOnUiThread
      }
      val r = try {
        SpeechRecognizer.createSpeechRecognizer(ctx)
      } catch (e: Exception) {
        Log.w(TAG, "no recognizer: ${e.message}")
        emit(id, "error") { it.putString("code", "unavailable") }
        return@runOnUiThread
      }
      recognizer = r
      r.setRecognitionListener(listener(id))
      try {
        r.startListening(intentFor(lang))
      } catch (e: Exception) {
        Log.w(TAG, "startListening failed: ${e.message}")
        emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_CLIENT) }
        destroyRecognizer()
      }
    }
  }

  /** Stop listening and answer with what was heard. */
  @ReactMethod
  fun stop() {
    UiThreadUtil.runOnUiThread {
      try { recognizer?.stopListening() } catch (_: Exception) {}
    }
  }

  /** Stop listening, answer nothing. */
  @ReactMethod
  fun cancel() {
    UiThreadUtil.runOnUiThread {
      val id = session
      val had = recognizer != null
      destroyRecognizer()
      if (had) emit(id, "error") { it.putString("code", "cancelled") }
    }
  }

  private fun intentFor(lang: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
    putExtra(RecognizerIntent.EXTRA_PROMPT, if (lang.startsWith("he")) "אמרו שם של סרט או סדרה" else "Say a movie or a show")
  }

  private fun listener(id: Int) = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) = emit(id, "ready")
    override fun onBeginningOfSpeech() = emit(id, "begin")
    override fun onRmsChanged(rmsdB: Float) {
      val now = SystemClock.uptimeMillis()
      if (now - lastLevelAt < 120) return
      lastLevelAt = now
      // about -2 dB (silence) to 10 dB (speech) on the services seen
      val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
      emit(id, "level") { it.putDouble("level", level.toDouble()) }
    }
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onError(error: Int) {
      Log.i(TAG, "error $error")
      emit(id, "error") { it.putInt("code", error) }
      destroyRecognizer()
    }
    override fun onResults(results: Bundle?) {
      emit(id, "final") { it.putString("text", first(results)) }
      destroyRecognizer()
    }
    override fun onPartialResults(partialResults: Bundle?) {
      val text = first(partialResults)
      if (text.isNotEmpty()) emit(id, "partial") { it.putString("text", text) }
    }
    override fun onEvent(eventType: Int, params: Bundle?) {}
  }

  private fun first(b: Bundle?): String =
    b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim() ?: ""

  private fun destroyRecognizer() {
    val r = recognizer ?: return
    recognizer = null
    try { r.cancel() } catch (_: Exception) {}
    try { r.destroy() } catch (_: Exception) {}
  }

  // ---------------------------------------------------------- 2. the system overlay

  @ReactMethod
  fun startIntent(lang: String, sessionId: Double) {
    val id = sessionId.toInt()
    UiThreadUtil.runOnUiThread {
      val activity = ctx.currentActivity
      if (activity == null) {
        emit(id, "error") { it.putString("code", "unavailable") }
        return@runOnUiThread
      }
      intentSession = id
      try {
        val i = intentFor(lang)
        i.removeExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS)
        activity.startActivityForResult(i, REQUEST)
        emit(id, "ready")
      } catch (e: ActivityNotFoundException) {
        intentSession = -1
        emit(id, "error") { it.putString("code", "unavailable") }
      } catch (e: Exception) {
        intentSession = -1
        emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_CLIENT) }
      }
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST || intentSession < 0) return
    val id = intentSession
    intentSession = -1
    val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim() ?: ""
    when {
      resultCode == Activity.RESULT_OK && text.isNotEmpty() -> emit(id, "final") { it.putString("text", text) }
      resultCode == Activity.RESULT_OK -> emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_NO_MATCH) }
      // RecognizerIntent.RESULT_* (1..5): the overlay's own failures
      resultCode == RecognizerIntent.RESULT_NETWORK_ERROR || resultCode == RecognizerIntent.RESULT_SERVER_ERROR ->
        emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_NETWORK) }
      resultCode == RecognizerIntent.RESULT_AUDIO_ERROR -> emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_AUDIO) }
      resultCode == RecognizerIntent.RESULT_NO_MATCH -> emit(id, "error") { it.putInt("code", SpeechRecognizer.ERROR_NO_MATCH) }
      else -> emit(id, "error") { it.putString("code", "cancelled") }
    }
  }

  override fun onNewIntent(intent: Intent) {}

  // ------------------------------------------------------------- the remote's key

  /** JS wants the remote's search / voice key while the app is in front. */
  @ReactMethod
  fun captureKeys(on: Boolean) {
    keysWanted = on
  }

  // NativeEventEmitter's bookkeeping
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  private fun emit(id: Int, type: String, fill: ((WritableMap) -> Unit)? = null) {
    if (!ctx.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putInt("session", id)
    map.putString("type", type)
    fill?.invoke(map)
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, map)
    } catch (_: Throwable) {}
  }

  private fun emitKey(code: Int) {
    if (!ctx.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putInt("keyCode", code)
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(KEY_EVENT, map)
    } catch (_: Throwable) {}
  }

  companion object {
    const val TAG = "AuroraVoice"
    const val EVENT = "AuroraVoice"
    const val KEY_EVENT = "AuroraVoiceKey"
    private const val REQUEST = 4711
    @Volatile private var current: VoiceModule? = null
    @Volatile private var keysWanted = false

    /** MainActivity: is this a voice key JS wants? Hands the press over and says true. */
    fun onVoiceKey(code: Int): Boolean {
      val m = current ?: return false
      if (!keysWanted) return false
      UiThreadUtil.runOnUiThread { m.emitKey(code) }
      return true
    }

    fun wantsKeys(): Boolean = current != null && keysWanted
  }
}
