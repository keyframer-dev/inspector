package dev.keyframer.inspector.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * WebSocket transport on OkHttp. WebSocket ping frames every 10 s stand in for the React Native
 * client's text "ping": OkHttp fails a socket whose pong never comes back, and the session reconnects.
 */
class OkHttpSockets(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
) : SocketFactory {
    override fun open(url: String, listener: SocketListener): InspectorSocket {
        var closed = false
        val ws = client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

                override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (!closed) listener.onClosed(reason).also { closed = true }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!closed) listener.onClosed(t.message).also { closed = true }
                }
            },
        )
        return object : InspectorSocket {
            override fun send(text: String) = ws.send(text)
            override fun close() {
                ws.close(1000, "disconnect")
            }
        }
    }
}
