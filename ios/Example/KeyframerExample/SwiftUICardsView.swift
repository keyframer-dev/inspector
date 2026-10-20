import KeyframerInspectorSwiftUI
import SwiftUI
import UIKit

/// A SwiftUI screen traced with KeyframerInspectorSwiftUI: an explicit animation reported from its call
/// site (withKeyframerAnimation) and an implicit one (`.animation(_:value:)`), each value sampled.
final class SwiftUIDemoModel: ObservableObject {
    static let shared = SwiftUIDemoModel()

    @Published var cardOffset: CGFloat = 0
    @Published var dotAtEnd = false

    func bounce() {
        withKeyframerAnimation(.spring(response: 0.5, dampingFraction: 0.55)) {
            cardOffset = cardOffset == 0 ? -120 : 0
        }
    }

    func shift() {
        dotAtEnd.toggle()
    }
}

struct SwiftUICardsView: View {
    @ObservedObject var model: SwiftUIDemoModel

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            RoundedRectangle(cornerRadius: 24)
                .fill(Color.indigo)
                .frame(width: 160, height: 160)
                .offset(y: model.cardOffset)
                .keyframerTrace("card", value: model.cardOffset)
            GeometryReader { geo in
                let dot = CGPoint(x: model.dotAtEnd ? geo.size.width - 28 : 28, y: 20)
                Circle()
                    .fill(Color.pink)
                    .frame(width: 24, height: 24)
                    .position(dot)
                    .keyframerTrace("dot", value: dot)
                    .animation(.easeInOut(duration: 0.6), value: model.dotAtEnd)
            }
            .frame(height: 40)
            HStack(spacing: 12) {
                Button("Bounce") { model.bounce() }
                    .accessibilityIdentifier("swiftui-bounce")
                Button("Shift") { model.shift() }
                    .accessibilityIdentifier("swiftui-shift")
            }
            .buttonStyle(.borderedProminent)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

/// Its own class, so navigation markers and playback name the screen.
final class SwiftUICardsController: UIHostingController<SwiftUICardsView> {
    init() {
        super.init(rootView: SwiftUICardsView(model: .shared))
        title = "SwiftUI"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }
}
