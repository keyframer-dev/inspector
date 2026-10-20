---
title: Render hints
description: What each SDK sees about how a moving view is drawn, and the fix per framework.
order: 4
section: Problems
---

# Render hints

Kind: `render-hint`. When something animates, the SDK looks at how the view is drawn and reports what costs the frame thread or the GPU work on every frame. Each finding is one problem, with what the SDK saw as evidence. The Values list shows the same hints as badges.

## Which SDK reports which hint

| Hint | React Native | iOS | Android | Flutter |
|---|---|---|---|---|
| `shadow-path` | Yes | Yes | | |
| `animated-shadow` | Yes | | | |
| `animated-layout` | Yes | | | |
| `animated-blur` | Yes | | | |
| `mask` | | Yes | Yes | Yes |
| `blur` | | Yes | Yes | Yes |
| `group-opacity` | | Yes | | |
| `rasterize` | | Yes | | |
| `layer-alpha` | | | Yes | |
| `elevation` | | | Yes | |
| `save-layer` | | | | Yes |
| `opacity-widget` | | | | Yes |

Compose reports no render hints yet. A hint key the inspector does not know comes with the SDK's own detail.

## shadow-path

A shadow without a known shape is worked out from pixels every frame.

- **React Native:** Give the view a `backgroundColor` so iOS can use its bounds, or draw the shadow once (an image, or a Skia shadow) under the moving view.
- **UIKit:** Set `layer.shadowPath` (`UIBezierPath(roundedRect:cornerRadius:).cgPath`).
- **SwiftUI:** Put the `.shadow` on a shape with a known outline (a `RoundedRectangle` background) rather than on the whole moving view, or flatten still content with `.drawingGroup()`.

```swift
card.layer.shadowPath = UIBezierPath(roundedRect: card.bounds, cornerRadius: 24).cgPath
```

## animated-shadow

React Native. Animating `shadowOpacity`, `shadowRadius`, `shadowOffset`, `elevation` or `boxShadow` draws the shadow again every frame. Keep the shadow fixed and fade in a shadowed view behind it, or move it with a transform.

## animated-layout

React Native. Animating width, height, margins or padding runs layout every frame. Animate a transform instead, or let a Reanimated layout animation (`LinearTransition`, `entering`, `exiting`) animate the size change. When the [layout animation](frames.md#layout-animation) problem already found it, it is reported there only.

## animated-blur

React Native. Animating a blur's radius or a BlurView's intensity blurs again every frame. Keep the radius fixed and fade between a sharp and a blurred view, or blur a still snapshot.

## mask

A mask over moving content is drawn offscreen every frame.

- **UIKit:** Use `cornerRadius` with `masksToBounds` for rounded corners, or keep the mask on a layer that does not change.
- **Android:** Clipping to a path outline (`clipToOutline` with `Outline.setPath`, API 33+) rasterizes again as the content moves. Clip to a rect or round rect outline (`Outline.setRoundRect`), which is cheap, or keep the clipped content still.
- **Flutter:** `ClipPath` and `ShaderMask` over moving content: clip with `ClipRRect` or `ClipRect` (`Clip.hardEdge`), or mask a child that stays still.

## blur

A blur over moving content is computed again every frame.

- **UIKit:** A `UIVisualEffectView` that moves, or has content moving under it: keep it still over still content while it shows, or fade in a pre-blurred snapshot.
- **Android:** The window blurs what is behind it (`FLAG_BLUR_BEHIND`, API 31+): keep content still while the blur shows, or blur a snapshot. A view's own `RenderEffect` cannot be seen.
- **Flutter:** `BackdropFilter` and `ImageFiltered` on moving content: keep the blur over still content, or blur the image once ahead of time.

## group-opacity

iOS. `opacity` animates on a layer with `allowsGroupOpacity` that draws sublayers over its own content, so the group is drawn offscreen first. Turn it off when the sublayers do not overlap, or animate the sublayers' alpha.

## rasterize

iOS. `shouldRasterize` on a layer whose animation changes what it draws: content that changes every frame renders that cache again each time. Turn it off while it animates.

## layer-alpha

Android. Alpha animates on a view with overlapping rendering and no hardware layer, so every frame draws it offscreen first. Give it a hardware layer for the animation (`setLayerType(LAYER_TYPE_HARDWARE)`, then `LAYER_TYPE_NONE`, as `ViewPropertyAnimator.withLayer()` does), or return false from `hasOverlappingRendering()` when its children do not overlap.

```kotlin
title.animate().alpha(1f).withLayer().start()
```

## elevation

Android. Elevation, `translationZ` or `z` animating draws the shadow again every frame. Keep the elevation fixed and animate translation or scale for the lift, or keep the outline a simple shape.

## save-layer

Flutter. `Clip.antiAliasWithSaveLayer` renders the clipped content into a saved layer every frame it moves. Use `Clip.antiAlias` or `Clip.hardEdge` unless the clip really needs the save layer.

## opacity-widget

Flutter. `Opacity` repaints its child through saveLayer on every frame it animates. Use `FadeTransition` (or `AnimatedOpacity`), which only changes the layer's alpha.

```dart
FadeTransition(opacity: controller, child: card)
```
