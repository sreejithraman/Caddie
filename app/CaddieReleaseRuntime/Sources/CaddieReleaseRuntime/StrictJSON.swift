import Foundation

enum StrictJSON {
    static let artifact = Set(["fingerprint", "path", "version"])
    static let compatibility = Set([
        "declarationVersion", "maximumStateFormatVersion", "minimumStateFormatVersion",
        "supportedSkillProtocolVersions", "toolProtocolVersion",
    ])

    static func validateManifest(_ data: Data) throws {
        let root = try object(data)
        try keys(root, ["app", "compatibility", "node", "releaseID", "skill", "tool", "version"])
        for name in ["app", "node", "tool", "skill"] { try keys(try child(root, name), artifact) }
        try keys(try child(root, "compatibility"), compatibility)
    }

    static func validateLaunchRecord(_ data: Data) throws {
        let root = try object(data)
        try keys(root, ["active", "lastGood", "revision", "version"])
        try validateBinding(try child(root, "active"))
        try validateBinding(try child(root, "lastGood"))
    }

    static func validateLease(_ data: Data) throws {
        try keys(try object(data), ["createdAt", "id", "processID", "releaseID", "version"])
    }

    static func validateLifecycleOwner(_ data: Data) throws {
        try keys(try object(data), ["createdAt", "nonce", "processID", "version"])
    }

    private static func validateBinding(_ value: [String: Any]) throws {
        try keys(value, ["compatibility", "node", "releaseID", "releasePath", "skill", "tool"])
        for name in ["node", "tool", "skill"] { try keys(try child(value, name), artifact) }
        try keys(try child(value, "compatibility"), compatibility)
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ShapeFault.invalid
        }
        return value
    }

    private static func child(_ value: [String: Any], _ name: String) throws -> [String: Any] {
        guard let child = value[name] as? [String: Any] else { throw ShapeFault.invalid }
        return child
    }

    private static func keys(_ value: [String: Any], _ expected: Set<String>) throws {
        guard Set(value.keys) == expected else { throw ShapeFault.invalid }
    }

    private enum ShapeFault: Error { case invalid }
}
