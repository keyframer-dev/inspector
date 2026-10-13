import KeyframerInspector
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let nav = UINavigationController(rootViewController: CardsViewController())
        nav.navigationBar.prefersLargeTitles = true
        window.rootViewController = nav
        window.makeKeyAndVisible()
        self.window = window

        #if DEBUG
            // Simulator: the relay on this Mac. A device: KeyframerInspector.start(.init(host: "<Mac LAN IP>")).
            KeyframerInspector.start(.init(appName: "Keyframer UIKit Example"))
            registerScenarios(nav)
        #endif
    }

    private func registerScenarios(_ nav: UINavigationController) {
        func press(_ id: String, wait ms: UInt64) -> @MainActor () async throws -> Void {
            return {
                guard KeyframerInspector.tap(id) else { throw ScenarioError.missing(id) }
                try await Task.sleep(nanoseconds: ms * 1_000_000)
            }
        }
        KeyframerInspector.registerScenario("bounce", press("bounce", wait: 800))
        KeyframerInspector.registerScenario("spin", press("spin", wait: 900))
        KeyframerInspector.registerScenario("fade", press("fade", wait: 700))
        KeyframerInspector.registerScenario("jank", press("jank", wait: 200))
        KeyframerInspector.registerScenario("push", press("push", wait: 900))
        KeyframerInspector.registerScenario("back") {
            nav.popToRootViewController(animated: true)
            try await Task.sleep(nanoseconds: 600_000_000)
        }
        KeyframerInspector.registerReplay {
            nav.popToRootViewController(animated: false)
            (nav.viewControllers.first as? CardsViewController)?.replayEntrance()
        }
        KeyframerInspector.registerNavigator { route, _ in
            switch route {
            case "CardsViewController":
                nav.popToRootViewController(animated: false)
                return true
            case "DetailViewController":
                if !(nav.topViewController is DetailViewController) { nav.pushViewController(DetailViewController(), animated: false) }
                return true
            default:
                return false
            }
        }
    }
}

enum ScenarioError: Error, CustomStringConvertible {
    case missing(String)
    var description: String {
        switch self {
        case .missing(let id): return "No control with accessibility identifier \(id)"
        }
    }
}
