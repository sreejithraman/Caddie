import CaddieReleaseRuntime
import Foundation

public enum CaddieBuildChannel: Equatable, Sendable {
    case development
    case release

    public init(bundleIdentifier: String?) {
        self = bundleIdentifier?.hasSuffix(".dev") == true ? .development : .release
    }

    public var startsAtLoginByDefault: Bool { false }
    public var installsUpdatesAutomaticallyByDefault: Bool { self == .release }
    public var applicationSupportFolder: String { self == .release ? "Caddie" : "Caddie Development" }

    public func toolEnvironment(base: [String: String], supportRoot: URL) -> [String: String] {
        guard self == .development else { return base }
        var environment = base
        environment["HOME"] = supportRoot.appendingPathComponent("Developer Home", isDirectory: true).path
        return environment
    }
}

public enum AppLocationBlock: Equatable, Sendable {
    case mountedVolume
    case downloads
    case appTranslocation
    case temporaryFolder
    case unsupportedFolder

    public var userMessage: String {
        switch self {
        case .mountedVolume:
            "Move Caddie to Applications, eject the disk image, then open Caddie again."
        case .downloads:
            "Move Caddie from Downloads to Applications, then open it again."
        case .appTranslocation:
            "Move Caddie to Applications, then open that copy."
        case .temporaryFolder:
            "Move Caddie to Applications, then open it again."
        case .unsupportedFolder:
            "Move Caddie to /Applications or your Applications folder, then open it again."
        }
    }
}

public enum AppLocationAssessment: Equatable, Sendable {
    case allowed
    case blocked(AppLocationBlock)
}

public struct AppLocationPolicy: Sendable {
    public init() {}

    public func assess(
        bundleURL: URL,
        homeURL: URL,
        channel: CaddieBuildChannel
    ) -> AppLocationAssessment {
        if channel == .development { return .allowed }

        let path = bundleURL.standardizedFileURL.path
        let resolvedPath = bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
        if resolvedPath != path { return .blocked(.unsupportedFolder) }
        if path.contains("/AppTranslocation/") { return .blocked(.appTranslocation) }
        if path == homeURL.appendingPathComponent("Downloads/Caddie.app").standardizedFileURL.path
            || path.hasPrefix(homeURL.appendingPathComponent("Downloads").standardizedFileURL.path + "/") {
            return .blocked(.downloads)
        }
        if path.hasPrefix("/Volumes/") { return .blocked(.mountedVolume) }
        if path.hasPrefix("/private/tmp/") || path.hasPrefix("/tmp/") || path.hasPrefix("/private/var/folders/") {
            return .blocked(.temporaryFolder)
        }

        let system = URL(fileURLWithPath: "/Applications/Caddie.app").standardizedFileURL.path
        let user = homeURL.appendingPathComponent("Applications/Caddie.app").standardizedFileURL.path
        return path == system || path == user ? .allowed : .blocked(.unsupportedFolder)
    }
}

public enum BootstrapStateCase: String, CaseIterable, Equatable, Sendable {
    case fresh
    case current
    case old
    case recovery
    case malformed
    case newer
}

public struct BootstrapStateEvidence: Equatable, Sendable {
    public let hasCaddieStateRoot: Bool
    public let hasLegacyState: Bool
    public let toolSnapshotState: String?
    public let recoveryIsActive: Bool
    public let toolErrorCode: String?

    public init(
        hasCaddieStateRoot: Bool,
        hasLegacyState: Bool = false,
        toolSnapshotState: String? = nil,
        recoveryIsActive: Bool = false,
        toolErrorCode: String? = nil
    ) {
        self.hasCaddieStateRoot = hasCaddieStateRoot
        self.hasLegacyState = hasLegacyState
        self.toolSnapshotState = toolSnapshotState
        self.recoveryIsActive = recoveryIsActive
        self.toolErrorCode = toolErrorCode
    }
}

public struct BootstrapStatePolicy: Sendable {
    public init() {}

    public func classify(_ evidence: BootstrapStateEvidence) -> BootstrapStateCase {
        if evidence.recoveryIsActive { return .recovery }
        if evidence.toolErrorCode == "unsupported-management-state-version" { return .newer }
        if evidence.toolErrorCode != nil { return .malformed }
        if !evidence.hasCaddieStateRoot && !evidence.hasLegacyState { return .fresh }
        if evidence.toolSnapshotState == "ready" { return .current }
        return .old
    }
}

public enum BootstrapDisposition: Equatable, Sendable {
    case proceedWithoutMovingState
    case requireRecoveryChoice
    case stopAndPreserveState
}

public struct BootstrapCoordinator: Sendable {
    private let policy = BootstrapStatePolicy()

    public init() {}

    public func disposition(for evidence: BootstrapStateEvidence) -> BootstrapDisposition {
        switch policy.classify(evidence) {
        case .fresh, .current, .old: .proceedWithoutMovingState
        case .recovery: .requireRecoveryChoice
        case .malformed, .newer: .stopAndPreserveState
        }
    }
}

public protocol DownloadedUpdateInstalling: Sendable {
    func installDownloadedUpdate() async throws
}

public protocol LifecycleReservation: Sendable {
    func release()
}

public protocol LifecycleReserving: Sendable {
    func reserve() async throws -> any LifecycleReservation
}

extension ReleaseLifecycleReservation: LifecycleReservation {}

public struct FileLifecycleReserver: LifecycleReserving, Sendable {
    private let runtime: CaddieReleaseRuntime

    public init(supportRoot: URL) {
        runtime = CaddieReleaseRuntime(supportRoot: supportRoot)
    }

    public func reserve() async throws -> any LifecycleReservation {
        try await runtime.acquireIdleLifecycleReservation()
    }
}

public actor IdleUpdateCoordinator {
    private let installer: any DownloadedUpdateInstalling
    private let lifecycle: any LifecycleReserving
    private var pending = false
    private var installing = false

    public init(installer: any DownloadedUpdateInstalling, lifecycle: any LifecycleReserving) {
        self.installer = installer
        self.lifecycle = lifecycle
    }

    public func updateReady() async throws {
        pending = true
        try await installWithExclusiveLifecycle()
    }

    public func retryPendingUpdate() async throws {
        try await installWithExclusiveLifecycle()
    }

    public var hasPendingUpdate: Bool { pending }

    private func installWithExclusiveLifecycle() async throws {
        guard pending, !installing else { return }
        installing = true
        let reservation: any LifecycleReservation
        do {
            reservation = try await lifecycle.reserve()
        } catch {
            installing = false
            throw error
        }
        defer {
            reservation.release()
            installing = false
        }
        try await installer.installDownloadedUpdate()
        pending = false
    }
}

public enum AppRemovalKind: Equatable, Sendable {
    case appOnly
    case homebrewZap
}

public struct AppRemovalPolicy: Sendable {
    public init() {}

    public func removablePaths(kind: AppRemovalKind, homeURL: URL) -> Set<URL> {
        guard kind == .homebrewZap else { return [] }
        let library = homeURL.appendingPathComponent("Library", isDirectory: true)
        return [
            library.appendingPathComponent("Caches/app.caddie.CaddieMenuApp", isDirectory: true),
            library.appendingPathComponent("Preferences/app.caddie.CaddieMenuApp.plist"),
        ]
    }

    public func preservesCaddieState(removing paths: Set<URL>, homeURL: URL) -> Bool {
        let userState = homeURL.appendingPathComponent(".agents/.caddie", isDirectory: true).standardizedFileURL.path
        let userSkills = homeURL.appendingPathComponent(".agents/skills", isDirectory: true).standardizedFileURL.path
        return paths.allSatisfy {
            let path = $0.standardizedFileURL.path
            return path != userState && !path.hasPrefix(userState + "/")
                && path != userSkills && !path.hasPrefix(userSkills + "/")
                && !path.hasSuffix("/.agents/.caddie") && !path.contains("/.agents/.caddie/")
        }
    }
}

public struct RepairChoice: Equatable, Sendable {
    public let title: String
    public let command: String?
    public let url: URL?

    public static let homebrew = RepairChoice(
        title: "Repair with Homebrew",
        command: "brew reinstall --cask caddie",
        url: nil
    )

    public static func signedRelease(_ url: URL) -> RepairChoice {
        RepairChoice(title: "Install a signed release", command: nil, url: url)
    }
}
