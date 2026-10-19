package com.auroratv

import android.app.SearchManager
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.BaseColumns
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Aurora's titles in the TV's own search (Android TV's system search asks every app whose
 * searchable says includeInGlobalSearch — res/xml/searchable.xml). Each row opens the title in
 * Aurora through the same link the home-screen rows use (`aurora://open?a=detail&d=…`,
 * homeScreen.ts parses it).
 *
 * It asks the server's suggestions (/api/search/suggest?v=2 — memory only, a few ms), as the
 * profile the app last said is on this TV (HomeScreenRows.configure — the same stored address,
 * session and unlock token the background job uses). No profile on this TV: no rows. Only the
 * system's search may read it (android.permission.GLOBAL_SEARCH, in the manifest).
 *
 * Google TV's own search does not ask apps any more; on those TVs this is simply never called.
 */
class SearchProvider : ContentProvider() {
  override fun onCreate() = true

  override fun query(uri: Uri, projection: Array<String>?, selection: String?, args: Array<String>?, sort: String?): Cursor {
    val cursor = MatrixCursor(COLUMNS)
    val q = (args?.firstOrNull() ?: uri.lastPathSegment ?: "").trim()
    if (q.length < 2 || q == SearchManager.SUGGEST_URI_PATH_QUERY) return cursor
    val ctx = context ?: return cursor
    try {
      fill(ctx, q, cursor)
    } catch (e: Exception) {
      Log.w(TAG, "suggestions not read: ${e.message}")
    }
    return cursor
  }

  private fun fill(ctx: Context, q: String, cursor: MatrixCursor) {
    val prefs = ctx.getSharedPreferences(HomeScreenRows.PREFS, Context.MODE_PRIVATE)
    val base = prefs.getString(HomeScreenRows.KEY_BASE, null) ?: return
    val profile = prefs.getString(HomeScreenRows.KEY_PROFILE, null) ?: return
    val session = prefs.getString(HomeScreenRows.KEY_SESSION, null)
    val token = prefs.getString(HomeScreenRows.KEY_TOKEN, null)
    val url = "$base/api/search/suggest?v=2&limit=8&q=${Uri.encode(q.take(80))}&profile=${Uri.encode(profile)}"
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 3000
    conn.readTimeout = 4000
    if (!token.isNullOrEmpty()) conn.setRequestProperty("X-Profile-Token", token)
    if (!session.isNullOrEmpty()) conn.setRequestProperty("X-Session", session)
    val body = try {
      if (conn.responseCode != 200) return
      conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    } finally {
      conn.disconnect()
    }
    val list = JSONObject(body).optJSONArray("suggestions") ?: return
    var n = 0
    for (i in 0 until list.length()) {
      val s = list.optJSONObject(i) ?: continue
      if (s.optString("kind") != "title") continue
      val title = s.optString("title").takeIf { it.isNotEmpty() } ?: continue
      val type = if (s.optString("type") == "show") "show" else "movie"
      val year = if (s.has("year") && !s.isNull("year")) s.optInt("year") else 0
      val id = s.optString("id", "")
      val inLibrary = s.optBoolean("inLibrary", false)
      val cover = s.optString("cover", "").takeIf { it.isNotEmpty() && it != "null" }
      // what Search.tsx pickSuggestion opens, as the home-screen link carries it
      val item = JSONObject()
      item.put("id", id)
      item.put("type", type)
      item.put("title", title)
      if (year > 0) item.put("year", year)
      s.optString("imdbId", "").takeIf { it.isNotEmpty() }?.let { item.put("imdbId", it) }
      cover?.let {
        item.put("cover", it)
        item.put("poster", it)
      }
      item.put("inLibrary", if (inLibrary && id.isNotEmpty()) id else JSONObject.NULL)
      item.put("source", if (inLibrary) "downloaded" else "stream")
      val link = "aurora://open?a=detail&d=" + Uri.encode(item.toString())
      val art = cover?.let { if (it.startsWith("http://") || it.startsWith("https://")) it else base + it }
      cursor.addRow(arrayOf<Any?>(
        n.toLong(),
        title,
        listOfNotNull(if (year > 0) year.toString() else null, if (type == "show") "Series" else "Film").joinToString(" · "),
        art,
        Intent.ACTION_VIEW,
        link,
        if (year > 0) year else null,
        "video/*",
      ))
      n++
    }
  }

  override fun getType(uri: Uri) = SearchManager.SUGGEST_MIME_TYPE
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, s: String?, a: Array<String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<String>?) = 0

  companion object {
    const val TAG = "AuroraSearch"
    private val COLUMNS = arrayOf(
      BaseColumns._ID,
      SearchManager.SUGGEST_COLUMN_TEXT_1,
      SearchManager.SUGGEST_COLUMN_TEXT_2,
      SearchManager.SUGGEST_COLUMN_RESULT_CARD_IMAGE,
      SearchManager.SUGGEST_COLUMN_INTENT_ACTION,
      SearchManager.SUGGEST_COLUMN_INTENT_DATA,
      SearchManager.SUGGEST_COLUMN_PRODUCTION_YEAR,
      SearchManager.SUGGEST_COLUMN_CONTENT_TYPE,
    )
  }
}
