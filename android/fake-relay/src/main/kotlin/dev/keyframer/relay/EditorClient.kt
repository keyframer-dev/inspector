package dev.keyframer.relay

import dev.keyframer.inspector.core.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A panel stand-in: connects to /editor, keeps every message it gets, and sends what a panel sends. */
class EditorClient(url: String) {
    private val lock = Object()
    private val received = ArrayList<Map<String, Any?>>()
    private val opened = CountDownLatch(1)
    private val client = OkHttpClient()
    private val ws: WebSocket = client.newWebSocket(
        Request.Builder().url(url).build(),
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = opened.countDown()

            override fun onMessage(webSocket: WebSocket, text: String) {
                @Suppress("UNCHECKED_CAST")
                val msg = runCatching { Json.parse(text) as? Map<String, Any?> }.getOrNull() ?: return
                synchronized(lock) {
                    received.add(msg)
                    lock.notifyAll()
                }
            }
        },
    )

    fun awaitOpen(timeoutMs: Long = 5000) {
        check(opened.await(timeoutMs, TimeUnit.MILLISECONDS)) { "editor could not connect" }
    }

    fun send(msg: Map<String, Any?>) {
        ws.send(Json.encode(msg))
    }

    fun messages(): List<Map<String, Any?>> = synchronized(lock) { received.toList() }

    fun ofType(type: String): List<Map<String, Any?>> = messages().filter { it["type"] == type }

    /** Waits for the first message matching `match`, failing after `timeoutMs`. */
    fun await(timeoutMs: Long = 5000, what: String = "message", match: (Map<String, Any?>) -> Boolean): Map<String, Any?> {
        val until = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (true) {
                received.firstOrNull(match)?.let { return it }
                val left = until - System.currentTimeMillis()
                check(left > 0) { "timed out waiting for $what; got types ${received.map { it["type"] }}" }
                lock.wait(left)
            }
        }
    }

    fun clear() = synchronized(lock) { received.clear() }

    fun close() {
        ws.close(1000, "done")
        client.dispatcher.executorService.shutdown()
    }
}

// Readers for the parsed messages.
@Suppress("UNCHECKED_CAST")
fun Any?.asList(): List<Any?> = (this as? List<Any?>) ?: emptyList()

@Suppress("UNCHECKED_CAST")
fun Any?.asMap(): Map<String, Any?> = (this as? Map<String, Any?>) ?: emptyMap()
