import Foundation

/// POST /v1/reports and GET /v1/config/<key> over URLSession. Plain HTTPS, gzip, no background session,
/// no cookies or caches, and never on a constrained network (Low Data Mode): such a send is deferred
/// to the next launch.
final class Uploader {
    enum Outcome: Error, Equatable {
        /// Accepted; the response's config, when it parsed.
        case sent(VitalsConfig?)
        /// 401 (key unknown or revoked) or 410 (project deleted): off on this device for 7 days.
        case stop
        /// 400 or 413: this report will never be accepted, drop it.
        case rejected
        /// 429, 5xx or no network: keep it for a retry.
        case retry
        /// Low Data Mode: keep it, retry on the next launch.
        case deferred
    }

    let endpoint: URL
    let key: String
    private let session: URLSession

    init(endpoint: URL, key: String, configuration: URLSessionConfiguration = .ephemeral) {
        self.endpoint = endpoint
        self.key = key
        let c = configuration
        c.allowsConstrainedNetworkAccess = false
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.httpShouldSetCookies = false
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    func send(_ body: Data, completion: @escaping (Outcome) -> Void) {
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/reports"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let gz = Gzip.compress(body), gz.count < body.count {
            request.setValue("gzip", forHTTPHeaderField: "Content-Encoding")
            request.httpBody = gz
        } else {
            request.httpBody = body
        }
        session.dataTask(with: request) { data, response, error in
            completion(Self.outcome(data: data, response: response, error: error))
        }.resume()
    }

    static func outcome(data: Data?, response: URLResponse?, error: Error?) -> Outcome {
        if let error = error as? URLError {
            if error.networkUnavailableReason == .constrained { return .deferred }
            return .retry
        }
        if error != nil { return .retry }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { return .retry }
        switch status {
        case 200..<300:
            let config = data.flatMap { try? JSONDecoder().decode(VitalsIngestResponse.self, from: $0) }?.config
            return .sent(config)
        case 401, 410: return .stop
        case 400, 413: return .rejected
        default: return .retry
        }
    }

    /// The project's config; nil when it could not be read. `stop` for 401 and 410.
    func fetchConfig(completion: @escaping (Result<VitalsConfig, Outcome>) -> Void) {
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/config").appendingPathComponent(key))
        request.httpMethod = "GET"
        session.dataTask(with: request) { data, response, error in
            let outcome = Self.outcome(data: nil, response: response, error: error)
            guard case .sent = outcome else { return completion(.failure(outcome)) }
            guard let data, let config = try? JSONDecoder().decode(VitalsConfig.self, from: data) else { return completion(.failure(.retry)) }
            completion(.success(config))
        }.resume()
    }
}
