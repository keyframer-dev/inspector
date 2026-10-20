package dev.keyframer.relay

import dev.keyframer.inspector.core.Json
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
 * "ping" with "pong" itself. Like the desktop app's relay, it tells editors which app is connected
 * (`apps`, so `keyframer-inspect ci --relay` and the MCP server can use it) and hands an editor that
 * joins later the app's hello and its speed.
 */
class FakeRelay(private val log: (String) -> Unit = {}) {
    private val server = MockWebServer()
    private val editors = CopyOnWriteArrayList<WebSocket>()
    @Volatile private var app: WebSocket? = null
    @Volatile var appQuery: String? = null
        private set
    @Volatile private var appNumber = 0
    @Volatile private var appSince = 0L
    @Volatile private var hello: String? = null
    @Volatile private var time: String? = null

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

    /** The desktop relay's `apps`: the one app (this relay keeps one), attached to every editor. */
    private fun appsMessage(): String {
        val query = appQuery.orEmpty().split('&').mapNotNull { kv ->
            kv.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to java.net.URLDecoder.decode(it[1], "UTF-8") }
        }.toMap()
        val id = "app-$appNumber"
        val list = if (app == null) emptyList() else listOf(
            linkedMapOf(
                "id" to id,
                "name" to (query["name"] ?: "app"),
                "platform" to (query["platform"] ?: "android"),
                "address" to "127.0.0.1",
                "connectedAt" to appSince,
                "editors" to editors.size,
            ),
        )
        return Json.encode(linkedMapOf("type" to "apps", "apps" to list, "attached" to (if (app == null) null else id), "mode" to "auto"))
    }

    private fun announceApps() {
        val msg = appsMessage()
        editors.forEach { it.send(msg) }
    }

    private fun appListener(query: String) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            app?.takeIf { it !== webSocket }?.close(4000, "replaced by a new app")
            app = webSocket
            appQuery = query
            appNumber++
            appSince = System.currentTimeMillis()
            hello = null
            time = null
            log("app joined ($query)")
            presence()
            announceApps()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text == "ping") {
                webSocket.send("pong")
                return
            }
            log("app → editors: ${summary(text)}")
            // What an editor that joins later needs first: the hello, then the speed.
            if (text.startsWith("""{"type":"hello"""")) hello = text
            if (text.startsWith("""{"type":"time"""")) time = text.takeUnless { it.contains(""""scale":1}""") }
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
                hello = null
                time = null
                log("app left")
                presence()
                announceApps()
            }
        }
    }

    private fun editorListener() = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            editors.add(webSocket)
            log("editor joined (${editors.size})")
            webSocket.send(appsMessage())
            presence()
            announceApps()
            hello?.let { webSocket.send(it) }
            time?.let { webSocket.send(it) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text == "ping") {
                webSocket.send("pong")
                return
            }
            log("editor → app: ${summary(text)}")
            // `select` is for the relay; with one app there is nothing to pick.
            if (text.startsWith("""{"type":"select"""")) {
                webSocket.send(appsMessage())
                return
            }
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
                announceApps()
            }
        }
    }

    companion object {
        fun summary(text: String): String = if (text.length <= 160) text else text.take(157) + "... (${text.length} chars)"
    }
}
