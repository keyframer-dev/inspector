#if canImport(UIKit)
import Foundation

/// One WebSocket to the relay, reconnecting with backoff (0.5 s doubling to 10 s, like the React
/// Native client). A WebSocket ping every 10 s keeps it honest: nothing heard for 25 s and it is
/// dropped and reopened, the room protocol's heartbeat without the text `ping`/`pong` frames.
@MainActor final class Connection {
    private static let heartbeatInterval: TimeInterval = 10
    private static let heartbeatTimeout: TimeInterval = 25
    private static let maxBackoff: TimeInterval = 10

    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    private(set) var isOpen = false

    private let url: URL
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var backoff: TimeInterval = 0.5
    private var reconnect: Timer?
    private var heartbeat: Timer?
    private var lastHeard = Date()
    private var stopped = false

    init(url: URL) {
        self.url = url
    }

    func connect() {
        guard !stopped, task == nil else { return }
        if session == nil {
            session = URLSession(configuration: .default, delegate: SessionDelegate(owner: self), delegateQueue: .main)
        }
        guard let task = session?.webSocketTask(with: url) else { return }
        // Playback messages carry whole recordings.
        task.maximumMessageSize = 64 * 1024 * 1024
        self.task = task
        task.resume()
        receive(on: task)
    }

    @discardableResult
    func send(_ text: String) -> Bool {
        guard isOpen, let task else { return false }
        task.send(.string(text)) { _ in }
        return true
    }

    func stop() {
        stopped = true
        reconnect?.invalidate()
        heartbeat?.invalidate()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isOpen = false
        session?.invalidateAndCancel()
        session = nil
    }

    fileprivate func didOpen(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        isOpen = true
        backoff = 0.5
        lastHeard = Date()
        heartbeat?.invalidate()
        heartbeat = Timer.scheduledTimer(withTimeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.beat() }
        }
        onOpen?()
    }

    fileprivate func didEnd(_ t: URLSessionTask) {
        guard t === task else { return }
        task = nil
        let wasOpen = isOpen
        isOpen = false
        heartbeat?.invalidate()
        heartbeat = nil
        if wasOpen { onClose?() }
        guard !stopped else { return }
        reconnect?.invalidate()
        reconnect = Timer.scheduledTimer(withTimeInterval: backoff, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.connect() }
        }
        backoff = min(backoff * 2, Self.maxBackoff)
    }

    private func beat() {
        guard let task, isOpen else { return }
        if Date().timeIntervalSince(lastHeard) > Self.heartbeatTimeout {
            // Silent for too long: the relay went away without a close.
            task.cancel(with: .goingAway, reason: nil)
            didEnd(task)
            return
        }
        task.sendPing { [weak self] error in
            guard error == nil else { return }
            DispatchQueue.main.async { self?.lastHeard = Date() }
        }
    }

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, t === self.task else { return }
                switch result {
                case .success(let message):
                    self.lastHeard = Date()
                    switch message {
                    case .string(let text): self.onText?(text)
                    case .data(let data): self.onText?(String(decoding: data, as: UTF8.self))
                    @unknown default: break
                    }
                    self.receive(on: t)
                case .failure:
                    self.didEnd(t)
                }
            }
        }
    }
}

/// URLSession keeps its delegate strongly; this one only points back weakly.
private final class SessionDelegate: NSObject, URLSessionWebSocketDelegate {
    weak var owner: Connection?

    init(owner: Connection) {
        self.owner = owner
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated { owner?.didOpen(webSocketTask) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated { owner?.didEnd(webSocketTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { owner?.didEnd(task) }
    }
}
#endif
