# Airlock Phase 2 Implementation Plan, part 3: Android, measurement, deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continues:** `docs/superpowers/plans/2026-08-16-airlock-phase2-part2.md`, tasks 18 through 20. Numbering is unbroken and the Phase 2 Global Constraints bind every task here.

---

### Task 21: Android shell with silent background receive

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`
- Create: `android/app/build.gradle.kts`, `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/java/dev/airlock/{MainActivity,ReceiverService,Crypto,Hkdf,Api,Prefs}.kt`
- Create: `android/app/src/main/res/values/strings.xml`, `res/xml/network_security_config.xml`
- Create: `web/vectors.mjs` and `android/app/src/test/resources/vectors.json`
- Create: `android/app/src/test/java/dev/airlock/CryptoVectorTest.kt`

**The one thing a PWA cannot do.** Everything else in Airlock works in the browser. Silent background receive does not: a service worker cannot write to the filesystem with the app closed. This shell exists for that single capability, wraps the same web UI in a WebView for everything else, and adds no second implementation of the interface.

**No Firebase.** Task 19's event stream is the wake-up signal. A foreground service holds one SSE connection over the tailnet, which removes an entire third-party dependency, needs no push permission, and is immediate. The Tailscale app is already running a persistent VPN service on this device, so this is not a new class of background cost.

**The crypto is native Kotlin, and its correctness is generated rather than trusted.** The JavaScript implementation emits a committed vector file; the Kotlin tests assert against it. Two implementations of a cipher is a drift risk, so drift fails the build instead of silently producing files that will not open.

- [ ] **Step 1: Write the vector generator**

Create `web/vectors.mjs`:

```js
// Emits the cross-language test vectors. The JavaScript implementation is the
// authority; the Kotlin suite asserts against what this writes. Generated, not
// mirrored: a divergence fails a build instead of producing files that will not
// open.
import { writeFileSync } from 'node:fs';
import {
  MODE_SEALED, DOMAIN, deriveMaster, chunkIdentity, sealChunk,
  sealRecord, b64encode, hex,
} from './crypto.js';

const PASSPHRASE = 'airlock cross language vector v1';
const SALT = b64encode(new Uint8Array(16).fill(0x2a));
const TID = '0123456789abcdef0123456789abcdef';
const enc = (s) => new TextEncoder().encode(s);

const mk = await deriveMaster(PASSPHRASE, SALT);

const chunks = [];
for (const text of ['', 'a', 'the quick brown fox', 'x'.repeat(5000)]) {
  const plain = enc(text);
  const { h, cid } = await chunkIdentity(mk, MODE_SEALED, plain);
  chunks.push({
    plaintextUtf8: text,
    hash: hex(h),
    cid,
    sealed: b64encode(await sealChunk(mk, MODE_SEALED, h, cid, plain)),
  });
}

// Records use a random IV, so a fixed expected value is impossible. The Kotlin
// side round trips these instead: open what JavaScript sealed.
const records = [];
for (const [name, domain] of Object.entries({ meta: DOMAIN.META, list: DOMAIN.LIST, thumb: DOMAIN.THUMB })) {
  const body = enc(`record body for ${name}`);
  records.push({
    domain: name,
    transferId: TID,
    plaintextUtf8: `record body for ${name}`,
    sealed: b64encode(await sealRecord(mk, MODE_SEALED, domain, TID, body)),
  });
}

writeFileSync('android/app/src/test/resources/vectors.json', JSON.stringify({
  passphrase: PASSPHRASE,
  saltBase64: SALT,
  pbkdf2Iterations: 600000,
  chunks,
  records,
}, null, 2) + '\n');

console.log(`wrote ${chunks.length} chunk vectors and ${records.length} record vectors`);
```

Run it: `mkdir -p android/app/src/test/resources && node web/vectors.mjs`

- [ ] **Step 2: Write the Gradle files**

`android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "Airlock"
include(":app")
```

`android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.7.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

`android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
```

`android/app/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.airlock"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.airlock"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests { isReturnDefaultValues = true } }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
```

The crypto uses only the JDK, so no cipher library appears here. `security-crypto` is for the Keystore-backed passphrase store, not for the algorithms.

- [ ] **Step 3: Write `Hkdf.kt`**

The JDK has PBKDF2 and AES-GCM but no HKDF, so RFC 5869 goes here rather than pulling a dependency for thirty lines.

```kotlin
package dev.airlock

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// RFC 5869 HKDF over HMAC-SHA256. The JDK has PBKDF2 and AES-GCM but not this,
// and it is not worth a dependency.
object Hkdf {
    private const val ALGORITHM = "HmacSHA256"
    private const val HASH_LEN = 32

    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance(ALGORITHM)
        // An all-zero key is the RFC's default when the salt is empty, and
        // SecretKeySpec rejects a zero-length key outright.
        val key = if (salt.isEmpty()) ByteArray(HASH_LEN) else salt
        mac.init(SecretKeySpec(key, ALGORITHM))
        return mac.doFinal(ikm)
    }

    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length <= 255 * HASH_LEN) { "requested key material is too long" }
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(prk, ALGORITHM))

        val out = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var counter = 1
        while (written < length) {
            mac.reset()
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val take = minOf(previous.size, length - written)
            previous.copyInto(out, written, 0, take)
            written += take
            counter++
        }
        return out
    }

    fun derive(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray =
        expand(extract(salt, ikm), info.toByteArray(Charsets.UTF_8), length)
}
```

- [ ] **Step 4: Write `Crypto.kt`**

Every constant here must match `web/crypto.js` exactly. The vector test is what proves it does.

```kotlin
package dev.airlock

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

object Crypto {
    const val MODE_PLAIN = 0x00
    const val MODE_SEALED = 0x01

    const val DOMAIN_META = 0x4d
    const val DOMAIN_LIST = 0x4c
    const val DOMAIN_THUMB = 0x54

    private const val PBKDF2_ITERATIONS = 600000
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    fun deriveMaster(passphrase: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(passphrase.toCharArray(), salt, PBKDF2_ITERATIONS, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    // The chunk id mixes the master key in, so only passphrase holders can
    // compute an id from a plaintext. A bare content hash would let anyone test
    // whether the server holds a file they already have.
    fun chunkId(master: ByteArray, mode: Int, hash: ByteArray): String =
        if (mode == MODE_PLAIN) hex(hash)
        else hex(Hkdf.derive(master, hash, "airlock-cid-v1", 32))

    fun openChunk(master: ByteArray, mode: Int, hash: ByteArray, cid: String, sealed: ByteArray): ByteArray {
        if (mode == MODE_PLAIN) return sealed
        val key = Hkdf.derive(master, hash, "airlock-key-v1", 32)
        val iv = Hkdf.derive(master, hash, "airlock-iv-v1", IV_LEN)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(unhex(cid))
        return cipher.doFinal(sealed)
    }

    // Records carry their mode in the first byte, so a reader is never told
    // which scheme was used.
    fun openRecord(master: ByteArray, domain: Int, transferId: String, record: ByteArray): ByteArray {
        require(record.isNotEmpty()) { "empty record" }
        if (record[0].toInt() and 0xff == MODE_PLAIN) return record.copyOfRange(1, record.size)
        require(record.size >= 1 + IV_LEN + 16) { "record too short" }

        val key = Hkdf.derive(master, ByteArray(32), "airlock-meta-v1", 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_BITS, record, 1, IV_LEN))
        cipher.updateAAD(recordAad(domain, transferId))
        return cipher.doFinal(record, 1 + IV_LEN, record.size - 1 - IV_LEN)
    }

    private fun recordAad(domain: Int, transferId: String): ByteArray {
        val id = unhex(transferId)
        require(id.size == 16) { "malformed transfer id" }
        return byteArrayOf(domain.toByte()) + id
    }

    fun unpackHashes(bytes: ByteArray): List<ByteArray> {
        require(bytes.size % 32 == 0) { "chunk list is not a whole number of hashes" }
        return (bytes.indices step 32).map { bytes.copyOfRange(it, it + 32) }
    }

    fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    fun unhex(s: String): ByteArray {
        require(s.length % 2 == 0) { "malformed hex" }
        return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
```

- [ ] **Step 5: Write the vector test**

`android/app/src/test/java/dev/airlock/CryptoVectorTest.kt`:

```kotlin
package dev.airlock

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

// These vectors are generated by web/vectors.mjs from the JavaScript
// implementation, which is the authority. If this test fails, the two
// implementations have drifted and files sealed by one will not open in the
// other. Regenerate rather than adjusting expectations here.
class CryptoVectorTest {
    private val vectors: JSONObject = JSONObject(
        javaClass.classLoader!!.getResourceAsStream("vectors.json")!!
            .bufferedReader().readText())

    private val master: ByteArray by lazy {
        Crypto.deriveMaster(
            vectors.getString("passphrase"),
            Base64.getDecoder().decode(vectors.getString("saltBase64")))
    }

    @Test
    fun pbkdf2IterationsMatch() {
        assertEquals(600000, vectors.getInt("pbkdf2Iterations"))
    }

    @Test
    fun chunkHashesAndIdsMatch() {
        val chunks = vectors.getJSONArray("chunks")
        for (i in 0 until chunks.length()) {
            val v = chunks.getJSONObject(i)
            val plain = v.getString("plaintextUtf8").toByteArray(Charsets.UTF_8)
            val hash = Crypto.sha256(plain)
            assertEquals("hash for vector $i", v.getString("hash"), Crypto.hex(hash))
            assertEquals(
                "cid for vector $i",
                v.getString("cid"),
                Crypto.chunkId(master, Crypto.MODE_SEALED, hash))
        }
    }

    @Test
    fun sealedChunksOpen() {
        val chunks = vectors.getJSONArray("chunks")
        for (i in 0 until chunks.length()) {
            val v = chunks.getJSONObject(i)
            val plain = v.getString("plaintextUtf8").toByteArray(Charsets.UTF_8)
            val hash = Crypto.sha256(plain)
            val sealed = Base64.getDecoder().decode(v.getString("sealed"))
            assertArrayEquals(
                "chunk $i",
                plain,
                Crypto.openChunk(master, Crypto.MODE_SEALED, hash, v.getString("cid"), sealed))
        }
    }

    @Test
    fun sealedRecordsOpen() {
        val domains = mapOf(
            "meta" to Crypto.DOMAIN_META,
            "list" to Crypto.DOMAIN_LIST,
            "thumb" to Crypto.DOMAIN_THUMB)
        val records = vectors.getJSONArray("records")
        for (i in 0 until records.length()) {
            val v = records.getJSONObject(i)
            val sealed = Base64.getDecoder().decode(v.getString("sealed"))
            val got = Crypto.openRecord(
                master, domains.getValue(v.getString("domain")),
                v.getString("transferId"), sealed)
            assertEquals(v.getString("plaintextUtf8"), String(got, Charsets.UTF_8))
        }
    }

    @Test(expected = Exception::class)
    fun aRecordFromOneDomainDoesNotOpenAsAnother() {
        val v = vectors.getJSONArray("records").getJSONObject(0)
        Crypto.openRecord(
            master, Crypto.DOMAIN_THUMB, v.getString("transferId"),
            Base64.getDecoder().decode(v.getString("sealed")))
    }
}
```

Run: `cd android && ./gradlew :app:testDebugUnitTest`

Do not proceed past a failure here. A drift between the two implementations produces files that download successfully and cannot be opened, which is the worst failure mode this project has.

- [ ] **Step 6: Write the app**

`android/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:usesCleartextTraffic="false"
        android:theme="@style/Theme.AppCompat.NoActionBar">

        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name=".ReceiverService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
    </application>
</manifest>
```

`Prefs.kt`:

```kotlin
package dev.airlock

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// The passphrase is the one secret this app holds, so it lives behind the
// Keystore rather than in plain preferences.
class Prefs(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "airlock",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)

    var baseUrl: String?
        get() = prefs.getString("baseUrl", null)
        set(v) = prefs.edit().putString("baseUrl", v).apply()

    var passphrase: String?
        get() = prefs.getString("passphrase", null)
        set(v) = prefs.edit().putString("passphrase", v).apply()

    fun isFetched(id: String) = prefs.getBoolean("fetched:$id", false)
    fun markFetched(id: String) = prefs.edit().putBoolean("fetched:$id", true).apply()
}
```

`MainActivity.kt` hosts the same web UI in a WebView and starts the service:

```kotlin
package dev.airlock

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

// The shell renders the same web UI rather than reimplementing it. The only
// native surface is the receiver service, which exists for the one capability a
// service worker cannot provide.
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)
        val base = prefs.baseUrl ?: DEFAULT_BASE_URL

        val web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            webViewClient = WebViewClient()
            loadUrl(base)
        }
        setContentView(web)

        val service = Intent(this, ReceiverService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service)
        else startService(service)
    }

    companion object {
        // Overridden by Prefs once configured. The default is only a first run
        // convenience.
        const val DEFAULT_BASE_URL = "https://airlock.example.ts.net/"
    }
}
```

`ReceiverService.kt` is the reason this module exists:

```kotlin
package dev.airlock

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import kotlin.concurrent.thread

// Holds one event stream open over the tailnet and downloads what arrives, with
// the app closed. This is the single capability a service worker cannot provide,
// and it is why a native shell exists at all.
class ReceiverService : Service() {
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) {
            running = true
            startForeground(1, notification("Watching for transfers"))
            thread(isDaemon = true) { loop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun loop() {
        val prefs = Prefs(this)
        while (running) {
            try {
                val base = prefs.baseUrl ?: MainActivity.DEFAULT_BASE_URL
                streamEvents(base) { drain(base, prefs) }
            } catch (e: Exception) {
                // Tailscale down, server restarting, or the device asleep. Back
                // off and try again rather than giving up for the session.
                Thread.sleep(15_000)
            }
        }
    }

    private fun streamEvents(base: String, onEvent: () -> Unit) {
        val conn = (URL("${base.trimEnd('/')}/api/events").openConnection() as HttpURLConnection)
        conn.readTimeout = 0
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.inputStream.bufferedReader().use { reader: BufferedReader ->
            // Drain once on connect: events missed while disconnected are not
            // replayed, and the inbox is the source of truth anyway.
            onEvent()
            while (running) {
                val line = reader.readLine() ?: break
                if (line.startsWith("event: inbox")) onEvent()
            }
        }
    }

    private fun drain(base: String, prefs: Prefs) {
        val passphrase = prefs.passphrase ?: return
        val config = JSONObject(get(base, "/api/config"))
        val master = Crypto.deriveMaster(
            passphrase, Base64.getDecoder().decode(config.getString("salt")))

        val inbox = JSONArray(get(base, "/api/inbox"))
        for (i in 0 until inbox.length()) {
            val t = inbox.getJSONObject(i)
            val id = t.getString("id")
            if (!t.getBoolean("complete") || prefs.isFetched(id)) continue
            try {
                save(base, master, id, t)
                prefs.markFetched(id)
            } catch (e: Exception) {
                // A transfer sealed with a different passphrase, or a chunk that
                // failed its tag. Leave it unmarked so a later pass retries.
            }
        }
    }

    private fun save(base: String, master: ByteArray, id: String, t: JSONObject) {
        val listRecord = getBytes(base, "/api/transfer/$id/chunklist")
        val mode = listRecord[0].toInt() and 0xff
        val hashes = Crypto.unpackHashes(
            Crypto.openRecord(master, Crypto.DOMAIN_LIST, id, listRecord))
        val meta = JSONObject(String(
            Crypto.openRecord(master, Crypto.DOMAIN_META, id,
                Base64.getDecoder().decode(t.getString("meta"))),
            Charsets.UTF_8))

        val cids = t.getJSONArray("cids")
        require(hashes.size == cids.length()) { "chunk list disagrees with the server record" }

        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, meta.getString("name"))
            put(MediaStore.Downloads.MIME_TYPE, meta.optString("mime", "application/octet-stream"))
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("could not create a download entry")

        resolver.openOutputStream(uri)!!.use { out ->
            for (i in 0 until cids.length()) {
                val cid = cids.getString(i)
                // Throws if the chunk was substituted or corrupted: its key
                // derives from the hash the sealed list gives for this position.
                out.write(Crypto.openChunk(master, mode, hashes[i], cid,
                    getBytes(base, "/api/chunk/$cid")))
            }
        }
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)

        notify(2, "Saved ${meta.getString("name")}")
    }

    private fun get(base: String, path: String) = String(getBytes(base, path), Charsets.UTF_8)

    private fun getBytes(base: String, path: String): ByteArray {
        val conn = (URL("${base.trimEnd('/')}$path").openConnection() as HttpURLConnection)
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.inputStream.use { return it.readBytes() }
    }

    private fun notification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL, "Airlock", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("Airlock")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .build()
    }

    private fun notify(id: Int, text: String) {
        getSystemService(NotificationManager::class.java).notify(id, notification(text))
    }

    companion object { private const val CHANNEL = "airlock" }
}
```

`res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Airlock</string>
</resources>
```

- [ ] **Step 7: Verify**

```bash
node web/vectors.mjs
cd android && ./gradlew :app:testDebugUnitTest && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On the device, with Tailscale connected:

1. Open the app. The same web UI appears and works.
2. Enter the passphrase once in the native settings path so `Prefs` holds it.
3. Close the app entirely, swipe it from recents.
4. Send a file from the desktop.
5. Within a few seconds a notification says the file was saved, and it is in Downloads without anyone having tapped anything. That is the capability this whole module exists for.
6. Turn Tailscale off, send another file, turn Tailscale back on, and confirm the service reconnects and fetches it.
7. Confirm the persistent notification is present the whole time, since a foreground service without one is not permitted.

- [ ] **Step 8: Commit**

```bash
git add android web/vectors.mjs
git commit -m "feat(android): webview shell with silent background receive over the event stream"
```

---

### Task 22: Throughput benchmark and the plaintext toggle

**Files:**
- Create: `bench_test.go`
- Create: `docs/benchmarks.md`
- Modify: `web/views/send.js` (the sealing toggle)
- Modify: `web/app.js` (carry the mode)

**Two decisions are waiting on numbers.** Whether `host` really beats `embedded` for the Tailscale mode default, and whether turning off encryption is worth anything at all. Both get measured here, and the answers get written down whichever way they come out.

**My prediction, recorded before running it, so the result can contradict me:** encryption will not be measurable against network time, because AES-GCM and SHA-256 reach native code through Web Crypto at gigabytes per second while a tailnet moves tens of megabytes per second. If that prediction is wrong the toggle earns its place; if it is right, the toggle stays but the documentation says plainly that it buys nothing.

- [ ] **Step 1: Write the local pipeline benchmark**

Create `bench_test.go`:

```go
package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// BenchmarkChunkStorePut measures the server side of an upload in isolation, so
// a slow end-to-end number can be attributed to the network rather than guessed
// at.
func BenchmarkChunkStorePut(b *testing.B) {
	for _, size := range []int{64 << 10, 1 << 20, 8 << 20} {
		b.Run(fmt.Sprintf("%dKiB", size>>10), func(b *testing.B) {
			dir := b.TempDir()
			store, err := NewChunkStore(dir, int64(size)+1024, 1<<40)
			if err != nil {
				b.Fatal(err)
			}
			body := make([]byte, size)
			rand.Read(body)

			b.SetBytes(int64(size))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				id := fmt.Sprintf("%064x", i)
				if err := store.Put(id, strings.NewReader(string(body))); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkSweep measures mark-and-sweep against a realistic chunk count, which
// is the one operation whose cost grows with the store rather than the transfer.
func BenchmarkSweep(b *testing.B) {
	dir := b.TempDir()
	store, _ := NewChunkStore(dir, 4096, 1<<40)
	transfers, _ := NewTransfers(dir, store, time.Hour, 100000, 4096)

	cids := make([]string, 5000)
	for i := range cids {
		cids[i] = fmt.Sprintf("%064x", i)
		store.Put(cids[i], strings.NewReader("x"))
	}
	transfers.Create("bench", nil, cids)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		referenced, err := transfers.Referenced()
		if err != nil {
			b.Fatal(err)
		}
		if _, err := store.Sweep(referenced); err != nil {
			b.Fatal(err)
		}
	}
	_ = os.Remove
}
```

Run: `go test -bench=. -benchmem -run=^$ ./...`

- [ ] **Step 2: Measure the two Tailscale modes**

The comparison that decides the default. On the server, in each mode in turn, with the client on another tailnet device:

```bash
head -c 8388608 /dev/urandom > /tmp/chunk8m
time for i in $(seq 1 128); do
  id=$(printf '%064x' $i)
  curl -s -o /dev/null -X PUT --data-binary @/tmp/chunk8m \
    "https://<node>.<tailnet>.ts.net/api/chunk/$id"
done
```

1 GiB per run. Record MB/s for `--tailscale-mode=host` and for `--tailscale-mode=embedded`.

- [ ] **Step 3: Measure sealed against plaintext**

In the browser, with the same file and a warm cache, upload once with sealing on and once off. Use the Performance panel to separate time spent in `chunkIdentity` and `sealChunk` from time spent in `fetch`. Record all three: total wall clock, crypto time, network time.

- [ ] **Step 4: Write down what happened**

Create `docs/benchmarks.md` with a table for each measurement, the hardware and network it was taken on, the date, and a short conclusion for each of the two open decisions. If a measurement contradicts the design's stated reasoning, say so in that file and open the question rather than burying it.

- [ ] **Step 5: Add the sealing toggle**

In `web/views/send.js`, above the recipient picker:

```js
  const sealed = el('input', { type: 'checkbox', id: 'sealed', checked: true });
  const sealNote = el('span', { class: 'data sealed' }, 'Sealed on this device');
  sealed.addEventListener('change', () => {
    state.mode = sealed.checked ? MODE_SEALED : MODE_PLAIN;
    sealNote.textContent = sealed.checked
      ? 'Sealed on this device'
      : 'Not sealed. Anyone with access to the server can read this.';
    sealNote.className = sealed.checked ? 'data sealed' : 'data bad';
  });
```

Import `MODE_SEALED` and `MODE_PLAIN` from `../crypto.js`. The copy is fixed by the visual design spec: the off state states the consequence plainly rather than softening it, and the warning color is `--breach`, which is used for nothing else.

Uploads read `state.mode`, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add bench_test.go docs/benchmarks.md web/views/send.js web/app.js
git commit -m "feat(bench): pipeline benchmarks, measured mode comparison and the sealing toggle"
```

---

### Task 23: Deployment and hardening

**Files:**
- Create: `deploy/airlock.service`, `deploy/sysctl-airlock.conf`
- Modify: `README.md`

- [ ] **Step 1: Write the systemd unit**

`deploy/airlock.service`:

```ini
[Unit]
Description=Airlock encrypted transfer
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=airlock
Group=airlock
ExecStart=/usr/local/bin/airlock --data /var/lib/airlock
Restart=on-failure
RestartSec=5

StateDirectory=airlock
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/var/lib/airlock

# Host mode reaches the tailscaled local API socket, which is root-owned on most
# installs. Grant the group rather than running the whole service as root.
SupplementaryGroups=tailscale

# Binding 443 without privilege.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the tuning notes**

`deploy/sysctl-airlock.conf`:

```conf
# Larger UDP buffers let the kernel batch WireGuard datagrams, which is where
# Tailscale's GSO and GRO throughput work pays off. Without these the receive
# path drops under load and throughput collapses well before the link does.
net.core.rmem_max = 7500000
net.core.wmem_max = 7500000
```

Apply with `sudo cp deploy/sysctl-airlock.conf /etc/sysctl.d/ && sudo sysctl --system`, then confirm `tailscale netcheck` no longer reports a UDP receive buffer warning.

- [ ] **Step 3: Bring the README up to date**

Rewrite the Status section to reflect what actually shipped, replace the flag table with the real flags, and add three things it currently lacks: the `--tailscale-mode` measurement result from `docs/benchmarks.md`, an Android install section, and a short "what this does not protect against" list naming chunk-equality leakage under dedup and the fact that a device holding the passphrase can read everything.

Re-read the whole README against the code before committing. Every enumerated claim in it, counts, file lists, flag names, is a claim that rots, so verify each one rather than patching the ones that look wrong.

- [ ] **Step 4: Full verification pass**

```bash
go vet ./... && go test ./... && go test -bench=. -run=^$ ./...
node --test web/*.test.mjs
cd android && ./gradlew :app:testDebugUnitTest
```

Then end to end on real hardware, with a phone and two desktops on the tailnet:

1. Send a 2 GB file desktop to desktop. `cmp` the result.
2. Send the same file again and confirm nothing uploads.
3. Append to it and send; confirm only the tail uploads.
4. Share a photo from the phone's gallery.
5. Close the Android app entirely and confirm the next send lands in Downloads on its own.
6. Pull the network mid-upload and confirm it resumes.
7. Reload mid-upload and confirm it resumes with no stored client state.
8. Revoke a device and confirm 403 on its next request.
9. `cat` a chunk on the server and confirm it is unreadable.
10. Corrupt a chunk on the server and confirm the download fails rather than producing a damaged file.

- [ ] **Step 5: Commit**

```bash
git add deploy README.md
git commit -m "docs: deployment unit, kernel tuning and a verified readme"
```
