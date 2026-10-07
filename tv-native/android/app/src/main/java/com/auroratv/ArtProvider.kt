package com.auroratv

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Hands the TV's home screen the pictures for Aurora's row.
 *
 * The launcher loads a row's art itself and cannot reach the Aurora server
 * (no session; a LAN server is plain http), so HomeScreenModule fetches each
 * picture into cache/homescreen/ and gives the launcher an address here.
 * A FileProvider address with a per-package grant was tried first and the
 * Google TV home still drew an empty tile (Mi TV, 2026-10-08) — whichever of
 * its processes loads the art is not one we could name. So this provider is
 * exported and read-only, and serves exactly one thing: a cached picture, by
 * its md5 name. Nothing else in the app is reachable through it.
 */
class ArtProvider : ContentProvider() {
  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val name = uri.lastPathSegment ?: throw FileNotFoundException()
    if (!Regex("^[0-9a-f]{32}[.]img$").matches(name)) throw FileNotFoundException()
    val file = File(File(context!!.cacheDir, "homescreen"), name)
    if (!file.exists()) throw FileNotFoundException()
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri) = "image/*"
  override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, s: String?, a: Array<String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<String>?) = 0
}
