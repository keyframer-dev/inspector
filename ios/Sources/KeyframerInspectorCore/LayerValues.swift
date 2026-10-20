import CoreGraphics
import Foundation
import QuartzCore

/// Layer properties as numbers: the protocol's samples are scalars, so a `position` animation is
/// recorded as two tracks, `position.x` and `position.y`. Every path returned here is one
/// `CALayer.value(forKeyPath:)` understands (Core Animation's key-value coding extensions).
public enum LayerKeyPath {
    private static let expansions: [String: [String]] = [
        "position": ["position.x", "position.y"],
        "anchorPoint": ["anchorPoint.x", "anchorPoint.y"],
        "bounds": ["bounds.origin.x", "bounds.origin.y", "bounds.size.width", "bounds.size.height"],
        "bounds.origin": ["bounds.origin.x", "bounds.origin.y"],
        "bounds.size": ["bounds.size.width", "bounds.size.height"],
        "transform": ["transform.translation.x", "transform.translation.y", "transform.scale.x", "transform.scale.y", "transform.rotation.z"],
        "transform.translation": ["transform.translation.x", "transform.translation.y"],
        "sublayerTransform": ["sublayerTransform.translation.x", "sublayerTransform.translation.y", "sublayerTransform.scale.x", "sublayerTransform.scale.y", "sublayerTransform.rotation.z"],
        "shadowOffset": ["shadowOffset.width", "shadowOffset.height"],
    ]

    /// Not numbers: colors, paths, images, filters. Not recorded (yet).
    private static let nonNumeric: Set<String> = [
        "backgroundColor", "borderColor", "shadowColor", "fillColor", "strokeColor", "path", "shadowPath",
        "contents", "filters", "backgroundFilters", "compositingFilter", "colors", "locations", "mask", "hidden",
    ]

    /// The scalar tracks one animated key path is recorded as.
    public static func scalarPaths(for keyPath: String) -> [String] {
        if let e = expansions[keyPath] { return e }
        if nonNumeric.contains(keyPath) { return [] }
        return [keyPath]
    }
}

public enum LayerValue {
    /// A Core Animation value as a number, when it is one.
    public static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    /// A Core Animation value (NSNumber, boxed CGPoint/CGSize/CGRect/CATransform3D, CGColor) as JSON
    /// for an animation's arguments. Boxed structs are read by their Objective-C type encoding, which
    /// is the same on iOS and macOS.
    public static func json(_ value: Any?) -> JSONValue {
        guard let value else { return .null }
        if let n = value as? NSNumber { return JSONValue(foundation: n) }
        if let v = value as? NSValue {
            let type = String(cString: v.objCType)
            if type.hasPrefix("{CGPoint=") {
                var p = CGPoint.zero
                v.getValue(&p, size: MemoryLayout<CGPoint>.size)
                return ["x": .number(Double(p.x)), "y": .number(Double(p.y))]
            }
            if type.hasPrefix("{CGSize=") {
                var s = CGSize.zero
                v.getValue(&s, size: MemoryLayout<CGSize>.size)
                return ["width": .number(Double(s.width)), "height": .number(Double(s.height))]
            }
            if type.hasPrefix("{CGRect=") {
                var r = CGRect.zero
                v.getValue(&r, size: MemoryLayout<CGRect>.size)
                return ["x": .number(Double(r.origin.x)), "y": .number(Double(r.origin.y)), "width": .number(Double(r.width)), "height": .number(Double(r.height))]
            }
            if type.hasPrefix("{CATransform3D=") {
                var t = CATransform3DIdentity
                v.getValue(&t, size: MemoryLayout<CATransform3D>.size)
                return transformJSON(t)
            }
            if type.hasPrefix("{CGAffineTransform=") {
                var t = CGAffineTransform.identity
                v.getValue(&t, size: MemoryLayout<CGAffineTransform>.size)
                return transformJSON(CATransform3DMakeAffineTransform(t))
            }
        }
        if CFGetTypeID(value as CFTypeRef) == CGColor.typeID {
            return .string(hex(value as! CGColor))
        }
        return JSONValue(foundation: value)
    }

    /// A 2D reading of a transform: translation, scale and z rotation, like React Native's transform keys.
    public static func transformJSON(_ t: CATransform3D) -> JSONValue {
        let sx = (Double(t.m11 * t.m11 + t.m12 * t.m12)).squareRoot()
        let sy = (Double(t.m21 * t.m21 + t.m22 * t.m22)).squareRoot()
        let rotation = atan2(Double(t.m12), Double(t.m11))
        func r(_ x: Double) -> JSONValue { .number((x * 10000).rounded() / 10000) }
        return ["translateX": r(Double(t.m41)), "translateY": r(Double(t.m42)), "scaleX": r(sx), "scaleY": r(sy), "rotation": r(rotation)]
    }

    public static func hex(_ color: CGColor) -> String {
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let c = color.converted(to: srgb, intent: .defaultIntent, options: nil) ?? color
        let comps = c.components ?? []
        let rgba: [CGFloat] = comps.count >= 4 ? Array(comps.prefix(4)) : comps.count == 2 ? [comps[0], comps[0], comps[0], comps[1]] : [0, 0, 0, 1]
        return "#" + rgba.map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
    }
}

extension LayerKeyPath {
    /// Rotations, which Core Animation reads back from the transform through atan2 (between -π and π).
    public static func isAngle(_ path: String) -> Bool {
        path.hasSuffix(".rotation") || path.hasSuffix(".rotation.x") || path.hasSuffix(".rotation.y") || path.hasSuffix(".rotation.z")
    }
}

/// Unwraps angle samples, one track at a time. Core Animation reads `transform.rotation.z` back
/// through atan2, so a 0 to 2π spin reads 0, 3.06, -3.00, 0: no travel, and a velocity spike where it
/// wraps. Each reading continues from the last one by the shortest turn instead, so the spin reads
/// 0 to 6.28 with its real velocity (QA 0.2.0, N6). It needs a reading at least every half turn,
/// which any frame rate gives.
public struct AngleUnwrapper: Sendable {
    private var last: [String: (raw: Double, unwrapped: Double)] = [:]

    public init() {}

    public mutating func unwrap(_ id: String, _ raw: Double) -> Double {
        guard let previous = last[id] else {
            last[id] = (raw, raw)
            return raw
        }
        let value = previous.unwrapped + remainder(raw - previous.raw, 2 * .pi)
        last[id] = (raw, value)
        return value
    }
}
