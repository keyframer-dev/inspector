package dev.keyframer.relay

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A stand-in for the desktop app's relay, as agreed between the SDKs:
 *
 *   ws://127.0.0.1:8790/app?name=<app>&platform=<platform>   one app (a new one replaces the old)
 *   ws://127.0.0.1:8790/editor                               any number of panels and CLIs
 *
 * Each text frame is one InspectorMessage. App frames go to every editor, editor frames to the app.
 * Like the pairing room, it sends `presence` to everyone on every join and leave, and answers a text
 * "ping" with "pong" itself.
 */
class FakeRelay(private val log: (String) -> Unit = {}) {
    private val server = MockWebServer()
    private val editors = CopyOnWriteArrayList<WebSocket>()
    @Volatile private var app: WebSocket? = null
    @Volatile var appQuery: String? = null
        private set

    val port: Int get() = server.port

    fun start(port: Int = 0, host: String = "127.0.0.1"): FakeRelay {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: "/"
                return when {
                    path == "/app" || path.startsWith("/app?") -> MockResponse().withWebSocketUpgrade(appListener(path.substringAfter('?', "")))
                    path == "/editor" || path.startsWith("/editor?") -> MockResponse().withWebSocketUpgrade(editorListener())
                    else -> MockResponse().setResponseCode(404).setBody("keyframer relay: connect to /app or /editor\n")
                }
            }
        }
        server.start(InetAddress.getByName(host), port)
        log("relay listening on ws://$host:${server.port} (/app, /editor)")
        return this
    }

    fun stop() {
        runCatching { app?.close(1001, "relay stopping") }
        editors.forEach { runCatching { it.close(1001, "relay stopping") } }
        runCatching { server.shutdown() }
    }

    private fun presence() {
        val msg = """{"type":"presence","app":${app != null},"editors":${editors.size},"cli":false}"""
        app?.send(msg)
        editors.forEach { it.send(msg) }
    }

    private fun appListener(query: String) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            app?.takeIf { it !== webSocket }?.close(4000, "replaced by a new app")
            app = webSocket
            appQuery = query
            log("app joined ($query)")
            presence()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text == "ping") {
                webSocket.send("pong")
                return
            }
            log("app → editors: ${summary(text)}")
            editors.forEach { it.send(text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = left(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = left(webSocket)

        private fun left(webSocket: WebSocket) {
            if (app === webSocket) {
                app = null
                log("app left")
                presence()
            }
        }
    }

    private fun editorListener() = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            editors.add(webSocket)
            log("editor joined (${editors.size})")
            presence()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text == "ping") {
                webSocket.send("pong")
                return
            }
            log("editor → app: ${summary(text)}")
            app?.send(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = left(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = left(webSocket)

        private fun left(webSocket: WebSocket) {
            if (editors.remove(webSocket)) {
                log("editor left (${editors.size})")
                presence()
            }
        }
    }

    companion object {
        fun summary(text: String): String = if (text.length <= 160) text else text.take(157) + "... (${text.length} chars)"
    }
}
