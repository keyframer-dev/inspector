import KeyframerInspector
import UIKit

/// One screen with one of each kind of animation the inspector should see.
final class CardsViewController: UIViewController {
    private let card = UIView()
    private let badge = CALayer()
    private let chips = UIScrollView()
    private let buttons = UIStackView()
    private var lowered = false
    private var dragStart = CGPoint.zero

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cards"
        view.backgroundColor = .systemBackground

        card.backgroundColor = .systemIndigo
        card.layer.cornerRadius = 24
        // An accessibility label for UI tests; no identifier, so the inspector names it after the property.
        card.isAccessibilityElement = true
        card.accessibilityLabel = "Card"
        card.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag(_:))))
        view.addSubview(card)

        badge.name = "badge"
        badge.backgroundColor = UIColor.systemYellow.cgColor
        badge.cornerRadius = 6
        card.layer.addSublayer(badge)

        for i in 0..<12 {
            let chip = UILabel()
            chip.text = "  Chip \(i + 1)  "
            chip.backgroundColor = .secondarySystemBackground
            chip.layer.cornerRadius = 14
            chip.clipsToBounds = true
            chip.frame = CGRect(x: 16 + i * 104, y: 8, width: 96, height: 32)
            chips.addSubview(chip)
        }
        chips.contentSize = CGSize(width: 16 + 12 * 104, height: 48)
        chips.showsHorizontalScrollIndicator = false
        chips.accessibilityIdentifier = "chips"
        view.addSubview(chips)

        buttons.axis = .vertical
        buttons.spacing = 8
        let row1 = UIStackView()
        let row2 = UIStackView()
        for row in [row1, row2] {
            row.distribution = .fillEqually
            row.spacing = 8
            buttons.addArrangedSubview(row)
        }
        row1.addArrangedSubview(button("Bounce", "bounce", #selector(bounce)))
        row1.addArrangedSubview(button("Spin", "spin", #selector(spin)))
        row1.addArrangedSubview(button("Fade", "fade", #selector(fade)))
        row2.addArrangedSubview(button("Jank", "jank", #selector(jank)))
        row2.addArrangedSubview(button("Push", "push", #selector(push)))
        view.addSubview(buttons)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaLayoutGuide.layoutFrame
        if card.bounds.width == 0 {
            card.frame = CGRect(x: safe.midX - 80, y: safe.minY + 40, width: 160, height: 160)
            badge.frame = CGRect(x: 16, y: 16, width: 28, height: 28)
            // Dragged by hand: recorded even when no animation runs.
            KeyframerInspector.track(card, as: "card")
        }
        chips.frame = CGRect(x: 0, y: safe.maxY - 200, width: view.bounds.width, height: 48)
        buttons.frame = CGRect(x: 16, y: safe.maxY - 136, width: view.bounds.width - 32, height: 112)
    }

    private func button(_ title: String, _ id: String, _ action: Selector) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        let b = UIButton(configuration: config)
        b.accessibilityIdentifier = id
        b.addTarget(self, action: action, for: .touchUpInside)
        return b
    }

    /// UIView.animate with a spring: Core Animation gets a CASpringAnimation on `position`.
    @objc func bounce() {
        lowered.toggle()
        let dy: CGFloat = lowered ? 160 : -160
        UIView.animate(withDuration: 0.6, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
            self.card.center.y += dy
        }
    }

    /// A hand-built CABasicAnimation, marked with an exact call site.
    @objc func spin() {
        KeyframerInspector.trace("card") {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = CGFloat.pi * 2
            spin.duration = 0.8
            spin.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            card.layer.add(spin, forKey: "spin")
        }
    }

    /// UIViewPropertyAnimator: opacity and scale.
    @objc func fade() {
        let dim = card.alpha > 0.9
        let animator = UIViewPropertyAnimator(duration: 0.5, curve: .easeInOut) {
            self.card.alpha = dim ? 0.35 : 1
            self.card.transform = dim ? CGAffineTransform(scaleX: 0.85, y: 0.85) : .identity
        }
        animator.startAnimation()
    }

    /// Blocks the main thread for 150 ms: a long frame the frame meter must catch.
    @objc func jank() {
        Thread.sleep(forTimeInterval: 0.15)
    }

    @objc func push() {
        navigationController?.pushViewController(DetailViewController(), animated: true)
    }

    @objc private func drag(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began: dragStart = card.center
        case .changed:
            let d = pan.translation(in: view)
            card.center = CGPoint(x: dragStart.x + d.x, y: dragStart.y + d.y)
        case .ended, .cancelled:
            UIView.animate(withDuration: 0.5, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0) {
                self.card.center = self.dragStart
            }
        default: break
        }
    }

    func replayEntrance() {
        card.alpha = 0
        card.transform = CGAffineTransform(translationX: 0, y: 60)
        UIView.animate(withDuration: 0.5, delay: 0, options: .curveEaseOut) {
            self.card.alpha = 1
            self.card.transform = .identity
        }
    }
}

/// A second screen: navigation markers, a delayed entrance and keyframes.
final class DetailViewController: UIViewController {
    private let header = UIView()
    private let dot = UIView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Detail"
        view.backgroundColor = .systemBackground
        header.backgroundColor = .systemTeal
        header.layer.cornerRadius = 16
        dot.backgroundColor = .systemPink
        dot.layer.cornerRadius = 12
        view.addSubview(header)
        view.addSubview(dot)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard header.bounds.width == 0 else { return }
        let safe = view.safeAreaLayoutGuide.layoutFrame
        header.frame = CGRect(x: 16, y: safe.minY + 24, width: safe.width - 32, height: 120)
        dot.frame = CGRect(x: 32, y: safe.minY + 200, width: 24, height: 24)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        header.transform = CGAffineTransform(translationX: 0, y: -40)
        header.alpha = 0
        UIView.animate(withDuration: 0.45, delay: 0.1, options: .curveEaseOut) {
            self.header.transform = .identity
            self.header.alpha = 1
        }
        let width = view.bounds.width - 88
        UIView.animateKeyframes(withDuration: 1.2, delay: 0) {
            UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.5) { self.dot.center.x += width }
            UIView.addKeyframe(withRelativeStartTime: 0.5, relativeDuration: 0.5) { self.dot.center.x -= width }
        }
    }
}
