import CryptoKit
import CaddieMacAppCore
import CaddieReleaseRuntime
import Foundation

public struct DevelopmentReleaseInstaller {
    private let fileManager: FileManager

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    @discardableResult
    public func install(
        app: URL,
        node: URL,
        skill: URL,
        supportRoot: URL,
        developerHome: URL,
        statusCheck: ToolStatusCheck? = nil
    ) async throws -> ToolLaunchRecord {
        try fileManager.createDirectory(at: developerHome, withIntermediateDirectories: true)
        try prepareDeveloperState(home: developerHome)
        let source = fileManager.temporaryDirectory
            .appendingPathComponent("caddie-development-release-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: source, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: source) }

        let stagedApp = source.appendingPathComponent("Caddie.app", isDirectory: true)
        let stagedNode = source.appendingPathComponent("node")
        let stagedSkill = source.appendingPathComponent("skill", isDirectory: true)
        try fileManager.copyItem(at: app.resolvingSymlinksInPath(), to: stagedApp)
        try fileManager.copyItem(at: node.resolvingSymlinksInPath(), to: stagedNode)
        try fileManager.copyItem(at: skill.resolvingSymlinksInPath(), to: stagedSkill)

        let stagedTool = stagedSkill.appendingPathComponent("tool/caddie.mjs")
        guard fileManager.fileExists(atPath: stagedTool.path) else {
            throw DevelopmentSetupFault.missingTool
        }
        let appFingerprint = try ReleaseFingerprint.digest(at: stagedApp)
        let nodeFingerprint = try ReleaseFingerprint.digest(at: stagedNode)
        let toolFingerprint = try ReleaseFingerprint.digest(at: stagedTool)
        let skillFingerprint = try ReleaseFingerprint.digest(at: stagedSkill)
        let releaseID = Self.releaseID(fingerprints: [appFingerprint, nodeFingerprint, toolFingerprint, skillFingerprint])

        func artifact(_ version: String, _ path: String, _ fingerprint: String) -> ReleaseArtifact {
            ReleaseArtifact(version: version, path: path, fingerprint: fingerprint)
        }
        let manifest = CaddieReleaseManifest(
            releaseID: releaseID,
            app: artifact("development", "Caddie.app", appFingerprint),
            node: artifact("development", "node", nodeFingerprint),
            tool: artifact("development", "skill/tool/caddie.mjs", toolFingerprint),
            skill: artifact("development", "skill", skillFingerprint),
            compatibility: .caddieCurrent
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(
            to: source.appendingPathComponent(CaddieReleaseRuntime.manifestName),
            options: .atomic
        )

        let check = statusCheck ?? { binding in
            var environment = ProcessInfo.processInfo.environment
            environment["HOME"] = developerHome.path
            try await StagedToolStatusChecker().check(binding: binding, environment: environment)
        }
        return try await CaddieReleaseRuntime(supportRoot: supportRoot)
            .stageCheckAndActivate(release: source, statusCheck: check)
    }

    private static func releaseID(fingerprints: [String]) -> String {
        let digest = SHA256.hash(data: Data(fingerprints.joined(separator: "\n").utf8))
        return "development-\(digest.prefix(12).map { String(format: "%02x", $0) }.joined())"
    }

    private func prepareDeveloperState(home: URL) throws {
        let stateRoot = home.appendingPathComponent(".agents/.caddie", isDirectory: true)
        let documents: [(String, [String: Any])] = [
            ("manifest.json", ["version": 1, "scope": "user", "sources": [:], "selections": []]),
            ("lock.json", ["version": 1, "sources": [:]]),
            ("ledger.json", [
                "version": 1, "scopeId": "user", "entries": [], "harnessLinks": [], "harnessSettings": [],
            ]),
        ]
        let existing = documents.filter { fileManager.fileExists(atPath: stateRoot.appendingPathComponent($0.0).path) }
        if existing.count == documents.count { return }
        guard existing.isEmpty else { throw DevelopmentSetupFault.incompleteState }
        try fileManager.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        for (name, document) in documents {
            let data = try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
            try (data + Data("\n".utf8)).write(to: stateRoot.appendingPathComponent(name), options: .atomic)
        }
    }
}

public enum DevelopmentSetupFault: Error, LocalizedError {
    case missingTool
    case incompleteState

    public var errorDescription: String? {
        switch self {
        case .missingTool:
            "The development Caddie Skill has no Tool entry point."
        case .incompleteState:
            "The development Caddie state fixture is incomplete."
        }
    }
}
