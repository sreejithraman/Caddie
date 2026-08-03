import Foundation

public struct ReleaseArtifact: Codable, Equatable, Sendable {
    public let version: String
    public let path: String
    public let fingerprint: String

    public init(version: String, path: String, fingerprint: String) {
        self.version = version
        self.path = path
        self.fingerprint = fingerprint
    }
}

public struct ReleaseCompatibility: Codable, Equatable, Sendable {
    public let declarationVersion: Int
    public let toolProtocolVersion: Int
    public let supportedSkillProtocolVersions: [Int]
    public let minimumStateFormatVersion: Int
    public let maximumStateFormatVersion: Int

    public init(
        declarationVersion: Int = 1,
        toolProtocolVersion: Int,
        supportedSkillProtocolVersions: [Int],
        minimumStateFormatVersion: Int,
        maximumStateFormatVersion: Int
    ) {
        self.declarationVersion = declarationVersion
        self.toolProtocolVersion = toolProtocolVersion
        self.supportedSkillProtocolVersions = supportedSkillProtocolVersions
        self.minimumStateFormatVersion = minimumStateFormatVersion
        self.maximumStateFormatVersion = maximumStateFormatVersion
    }
}

public struct CaddieReleaseManifest: Codable, Equatable, Sendable {
    public let version: Int
    public let releaseID: String
    public let app: ReleaseArtifact
    public let node: ReleaseArtifact
    public let tool: ReleaseArtifact
    public let skill: ReleaseArtifact
    public let compatibility: ReleaseCompatibility

    public init(
        version: Int = 1,
        releaseID: String,
        app: ReleaseArtifact,
        node: ReleaseArtifact,
        tool: ReleaseArtifact,
        skill: ReleaseArtifact,
        compatibility: ReleaseCompatibility
    ) {
        self.version = version
        self.releaseID = releaseID
        self.app = app
        self.node = node
        self.tool = tool
        self.skill = skill
        self.compatibility = compatibility
    }
}

public struct ToolReleaseBinding: Codable, Equatable, Sendable {
    public let releaseID: String
    public let releasePath: String
    public let node: ReleaseArtifact
    public let tool: ReleaseArtifact
    public let skill: ReleaseArtifact
    public let compatibility: ReleaseCompatibility

    public init(
        releaseID: String,
        releasePath: String,
        node: ReleaseArtifact,
        tool: ReleaseArtifact,
        skill: ReleaseArtifact,
        compatibility: ReleaseCompatibility
    ) {
        self.releaseID = releaseID
        self.releasePath = releasePath
        self.node = node
        self.tool = tool
        self.skill = skill
        self.compatibility = compatibility
    }
}

public struct ToolLaunchRecord: Codable, Equatable, Sendable {
    public let version: Int
    public let revision: Int
    public let active: ToolReleaseBinding
    public let lastGood: ToolReleaseBinding

    public init(version: Int = 1, revision: Int, active: ToolReleaseBinding, lastGood: ToolReleaseBinding) {
        self.version = version
        self.revision = revision
        self.active = active
        self.lastGood = lastGood
    }
}

public struct ToolLease: Codable, Equatable, Sendable {
    public let version: Int
    public let id: UUID
    public let releaseID: String
    public let processID: Int32
    public let createdAt: Date

    public init(version: Int = 1, id: UUID, releaseID: String, processID: Int32, createdAt: Date) {
        self.version = version
        self.id = id
        self.releaseID = releaseID
        self.processID = processID
        self.createdAt = createdAt
    }
}

public struct TakeoverClaimEvidence: Equatable, Sendable {
    public let path: String
    public let nonce: UUID
    public let processID: Int32
    public let createdAt: Date
    public let processIsAlive: Bool

    public init(path: String, nonce: UUID, processID: Int32, createdAt: Date, processIsAlive: Bool) {
        self.path = path
        self.nonce = nonce
        self.processID = processID
        self.createdAt = createdAt
        self.processIsAlive = processIsAlive
    }
}

public enum ReleaseRuntimeFault: Error, Equatable, LocalizedError {
    case missingManifest
    case malformedManifest
    case unsupportedManifestVersion(Int)
    case invalidReleaseID
    case invalidArtifactPath(String)
    case missingArtifact(String)
    case symbolicLinkArtifact(String)
    case fingerprintMismatch(String)
    case incompatibleRelease(String)
    case statusCheckFailed(String)
    case missingLaunchRecord
    case malformedLaunchRecord
    case malformedLease
    case malformedLifecycleClaim
    case lifecycleClaimBusy
    case takeoverClaimPresent
    case noUsableLastGood
    case stagedReleaseExists(String)

    public var errorDescription: String? {
        switch self {
        case .missingManifest: "The Caddie Release manifest is missing."
        case .malformedManifest: "The Caddie Release manifest is malformed."
        case .unsupportedManifestVersion(let version): "Caddie Release manifest version \(version) is not supported."
        case .invalidReleaseID: "The Caddie Release ID is invalid."
        case .invalidArtifactPath(let path): "The Caddie Release artifact path is unsafe: \(path)"
        case .missingArtifact(let name): "The Caddie Release is missing \(name)."
        case .symbolicLinkArtifact(let name): "The Caddie Release uses a symbolic link for \(name)."
        case .fingerprintMismatch(let name): "The Caddie Release fingerprint does not match for \(name)."
        case .incompatibleRelease(let reason): "The Caddie Release is not compatible: \(reason)"
        case .statusCheckFailed(let reason): "The staged Caddie Tool failed its first status check: \(reason)"
        case .missingLaunchRecord: "The Tool Launch Record is missing."
        case .malformedLaunchRecord: "The Tool Launch Record is malformed."
        case .malformedLease: "A Tool lease is malformed, so Caddie cannot remove an older release."
        case .malformedLifecycleClaim: "The Caddie Release lifecycle claim is malformed."
        case .lifecycleClaimBusy: "Another Caddie Release lifecycle action is still running."
        case .takeoverClaimPresent: "The stale Caddie Release claim takeover is already owned or incomplete."
        case .noUsableLastGood: "No checked last-good Caddie Tool is available."
        case .stagedReleaseExists(let id): "A different staged Caddie Release already uses ID \(id)."
        }
    }
}
