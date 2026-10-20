// Motion Vitals symbol fixture: Swift names, to check the swift-demangle pass.
struct CardAnimation {
  var scale: Double

  func step(_ t: Double) -> Double {
    return scale * t
  }
}

@inline(never)
func expandCard(_ t: Double) -> Double {
  let card = CardAnimation(scale: 1.5)
  return card.step(t)
}

print(expandCard(0.5))
