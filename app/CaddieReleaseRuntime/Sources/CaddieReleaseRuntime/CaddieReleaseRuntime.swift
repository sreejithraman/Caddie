import Darwin
import Foundation

public typealias ToolStatusCheck = @Sendable (ToolReleaseBinding) async throws -> Void
public typealias ReleaseStepObserver = @Sendable (CaddieReleaseRuntime.Step) throws -> Void

public actor CaddieReleaseRuntime {
    public enum Step: String, CaseIterable, Sendable {
        case copiedToStaging
        case checkedStaging
        case promotedRelease
        case passedStatus
        case switchedLaunchRecord
    }

    public static let manifestName = "caddie-release.json"
    public static let launchRecordName = "Tool Launch Record.json"

    public let supportRoot: URL
    private let releasesRoot: URL
    private let stagingRoot: URL
    private let leasesRoot: URL
    private let launchRecordURL: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let observeStep: ReleaseStepObserver
    private var activatingReleaseIDs = Set<String>()
    private var lifecycleOperationInProgress = false

    public init(
        supportRoot: URL,
        fileManager: FileManager = .default,
        observeStep: @escaping ReleaseStepObserver = { _ in }
    ) {
        self.supportRoot = supportRoot.standardizedFileURL
        self.releasesRoot = supportRoot.appendingPathComponent("Releases", isDirectory: true)
        self.stagingRoot = supportRoot.appendingPathComponent("Staging", isDirectory: true)
        self.leasesRoot = supportRoot.appendingPathComponent("Leases", isDirectory: true)
        self.launchRecordURL = supportRoot.appendingPathComponent(Self.launchRecordName)
        self.fileManager = fileManager
        self.observeStep = observeStep
        self.encoder = .caddie
        self.decoder = .caddie
    }

    @discardableResult
    public func stageCheckAndActivate(
        release source: URL,
        statusCheck: ToolStatusCheck
    ) async throws -> ToolLaunchRecord {
        try prepareRoots()
        let manifest = try readManifest(at: source)
        try ReleaseManifestRules.validateManifest(manifest)
        guard !lifecycleOperationInProgress else { throw ReleaseRuntimeFault.lifecycleClaimBusy }
        lifecycleOperationInProgress = true
        defer { lifecycleOperationInProgress = false }
        let lifecycleClaim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        defer { lifecycleClaim.release() }
        activatingReleaseIDs.insert(manifest.releaseID)
        defer { activatingReleaseIDs.remove(manifest.releaseID) }

        let staging = stagingRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.copyItem(at: source, to: staging)
        try observeStep(.copiedToStaging)
        do {
            try verify(manifest, in: staging)
            try observeStep(.checkedStaging)

            let destination = releasesRoot.appendingPathComponent(manifest.releaseID, isDirectory: true)
            if fileManager.fileExists(atPath: destination.path) {
                let installed = try readManifest(at: destination)
                guard installed == manifest else { throw ReleaseRuntimeFault.stagedReleaseExists(manifest.releaseID) }
                do {
                    try verify(installed, in: destination)
                    try fileManager.removeItem(at: staging)
                } catch {
                    let protected = try protectedReleaseIDs()
                    guard !protected.contains(manifest.releaseID) else { throw error }
                    try fileManager.removeItem(at: destination)
                    try fileManager.moveItem(at: staging, to: destination)
                }
            } else {
                try fileManager.moveItem(at: staging, to: destination)
            }
            try observeStep(.promotedRelease)

            try verify(manifest, in: destination)
            let binding = ReleaseManifestRules.absoluteBinding(manifest, releaseRoot: destination)
            try verify(binding)
            do { try await statusCheck(binding) } catch {
                throw ReleaseRuntimeFault.statusCheckFailed(String(describing: error))
            }
            try verify(manifest, in: destination)
            try verify(binding)
            try observeStep(.passedStatus)

            let prior: ToolLaunchRecord?
            if fileManager.fileExists(atPath: launchRecordURL.path) {
                prior = try readLaunchRecord()
                try verify(prior!.active)
                try verify(prior!.lastGood)
            }
            else { prior = nil }
            let next = ToolLaunchRecord(
                revision: (prior?.revision ?? 0) + 1,
                active: binding,
                lastGood: prior?.lastGood ?? binding
            )
            try writeLaunchRecord(next)
            try observeStep(.switchedLaunchRecord)
            return next
        } catch {
            if fileManager.fileExists(atPath: staging.path) { try? fileManager.removeItem(at: staging) }
            throw error
        }
    }

    public func checkedLaunchRecord() throws -> ToolLaunchRecord {
        let record = try readLaunchRecord()
        try verify(record.active)
        try verify(record.lastGood)
        return record
    }

    public func acquireLifecycleReservation() throws -> ReleaseLifecycleReservation {
        ReleaseLifecycleReservation(
            claim: try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        )
    }

    public func acquireIdleLifecycleReservation() async throws -> ReleaseLifecycleReservation {
        try prepareRoots()
        let claim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        do {
            while try hasLiveLeases() {
                try Task.checkCancellation()
                try await Task.sleep(for: .milliseconds(20))
            }
            try Task.checkCancellation()
            return ReleaseLifecycleReservation(claim: claim)
        } catch {
            claim.release()
            throw error
        }
    }

    public func inspectTakeoverClaim() throws -> TakeoverClaimEvidence? {
        let path = supportRoot.appendingPathComponent("Release Lifecycle.takeover", isDirectory: true)
        guard fileManager.fileExists(atPath: path.path) else { return nil }
        let owner = try readLifecycleOwner(directory: path, fileManager: fileManager)
        return TakeoverClaimEvidence(
            path: path.path,
            nonce: owner.nonce,
            processID: owner.processID,
            createdAt: owner.createdAt,
            processIsAlive: processIsAlive(owner.processID)
        )
    }

    @discardableResult
    public func confirmActiveAsLastGood(verification: ToolStatusCheck) async throws -> ToolLaunchRecord {
        guard !lifecycleOperationInProgress else { throw ReleaseRuntimeFault.lifecycleClaimBusy }
        lifecycleOperationInProgress = true
        defer { lifecycleOperationInProgress = false }
        let lifecycleClaim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        defer { lifecycleClaim.release() }
        let record = try readLaunchRecord()
        try verify(record.active)
        try await verification(record.active)
        try verify(record.active)
        let current = try readLaunchRecord()
        guard current == record else { throw ReleaseRuntimeFault.malformedLaunchRecord }
        let confirmed = ToolLaunchRecord(
            revision: record.revision + 1,
            active: record.active,
            lastGood: record.active
        )
        try writeLaunchRecord(confirmed)
        return confirmed
    }

    @discardableResult
    public func ensureUsableActive(statusCheck: ToolStatusCheck) async throws -> ToolLaunchRecord {
        guard !lifecycleOperationInProgress else { throw ReleaseRuntimeFault.lifecycleClaimBusy }
        lifecycleOperationInProgress = true
        defer { lifecycleOperationInProgress = false }
        let lifecycleClaim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        defer { lifecycleClaim.release() }
        let record = try readLaunchRecord()
        do {
            try verify(record.active)
            try await statusCheck(record.active)
            try verify(record.active)
            return record
        } catch {
            guard record.lastGood.releaseID != record.active.releaseID else {
                throw ReleaseRuntimeFault.noUsableLastGood
            }
            do {
                try verify(record.lastGood)
                try await statusCheck(record.lastGood)
                try verify(record.lastGood)
            } catch {
                throw ReleaseRuntimeFault.noUsableLastGood
            }
            let fallback = ToolLaunchRecord(
                revision: record.revision + 1,
                active: record.lastGood,
                lastGood: record.lastGood
            )
            try writeLaunchRecord(fallback)
            return fallback
        }
    }

    public func acquireLease(for binding: ToolReleaseBinding, processID: Int32) throws -> ToolLease {
        try prepareRoots()
        guard !lifecycleOperationInProgress, processID > 0 else {
            throw processID > 0 ? ReleaseRuntimeFault.lifecycleClaimBusy : ReleaseRuntimeFault.malformedLease
        }
        let lifecycleClaim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        defer { lifecycleClaim.release() }
        try verify(binding)
        let lease = ToolLease(id: UUID(), releaseID: binding.releaseID, processID: processID, createdAt: Date())
        let destination = leasesRoot.appendingPathComponent("\(lease.id.uuidString).json")
        try encoder.encode(lease).write(to: destination, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return lease
    }

    public func releaseLease(_ lease: ToolLease) throws {
        let destination = leasesRoot.appendingPathComponent("\(lease.id.uuidString).json")
        if fileManager.fileExists(atPath: destination.path) { try fileManager.removeItem(at: destination) }
    }

    @discardableResult
    public func cleanUnusedReleases() throws -> [String] {
        try prepareRoots()
        guard !lifecycleOperationInProgress else { throw ReleaseRuntimeFault.lifecycleClaimBusy }
        let lifecycleClaim = try acquireLifecycleClaim(supportRoot: supportRoot, fileManager: fileManager)
        defer { lifecycleClaim.release() }
        let record = try readLaunchRecord()
        var retained = try protectedReleaseIDs(record: record)
        retained.formUnion(activatingReleaseIDs)

        var removed: [String] = []
        for release in try fileManager.contentsOfDirectory(at: releasesRoot, includingPropertiesForKeys: nil) {
            guard release.hasDirectoryPath || (try? release.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                  !retained.contains(release.lastPathComponent) else { continue }
            _ = try readManifest(at: release)
            let immediatelyProtected = try protectedReleaseIDs(record: try readLaunchRecord())
            guard !immediatelyProtected.contains(release.lastPathComponent),
                  !activatingReleaseIDs.contains(release.lastPathComponent) else { continue }
            try fileManager.removeItem(at: release)
            removed.append(release.lastPathComponent)
        }
        return removed.sorted()
    }

    private func prepareRoots() throws {
        try fileManager.createDirectory(at: releasesRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: leasesRoot, withIntermediateDirectories: true)
    }

    private func readManifest(at root: URL) throws -> CaddieReleaseManifest {
        let url = root.appendingPathComponent(Self.manifestName)
        guard fileManager.fileExists(atPath: url.path) else { throw ReleaseRuntimeFault.missingManifest }
        do {
            guard try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true,
                  url.resolvingSymlinksInPath() == root.resolvingSymlinksInPath().appendingPathComponent(Self.manifestName) else {
                throw ReleaseRuntimeFault.malformedManifest
            }
            let data = try Data(contentsOf: url)
            try StrictJSON.validateManifest(data)
            return try decoder.decode(CaddieReleaseManifest.self, from: data)
        }
        catch { throw ReleaseRuntimeFault.malformedManifest }
    }

    private func verify(_ manifest: CaddieReleaseManifest, in root: URL) throws {
        try ReleaseManifestRules.validateManifest(manifest)
        for (name, artifact) in [("app", manifest.app), ("Node", manifest.node), ("Tool", manifest.tool), ("Skill", manifest.skill)] {
            let url = root.appendingPathComponent(try ReleaseManifestRules.safeRelativePath(artifact.path))
            guard fileManager.fileExists(atPath: url.path) else { throw ReleaseRuntimeFault.missingArtifact(name) }
            let relative = try ReleaseManifestRules.safeRelativePath(artifact.path)
            let canonicalRoot = root.resolvingSymlinksInPath()
            guard url.resolvingSymlinksInPath() == canonicalRoot.appendingPathComponent(relative).standardizedFileURL else {
                throw ReleaseRuntimeFault.symbolicLinkArtifact(name)
            }
            let actual: String
            do { actual = try ReleaseFingerprint.digest(at: url, fileManager: fileManager) }
            catch ReleaseFingerprintFault.symbolicLink { throw ReleaseRuntimeFault.symbolicLinkArtifact(name) }
            guard actual == artifact.fingerprint else {
                throw ReleaseRuntimeFault.fingerprintMismatch(name)
            }
        }
    }

    private func verify(_ binding: ToolReleaseBinding) throws {
        let releaseRoot = URL(fileURLWithPath: binding.releasePath).standardizedFileURL
        let expectedRoot = releasesRoot.appendingPathComponent(binding.releaseID, isDirectory: true).standardizedFileURL
        let canonicalReleases = releasesRoot.resolvingSymlinksInPath()
        let canonicalRoot = releaseRoot.resolvingSymlinksInPath()
        let rootValues = try? releaseRoot.resourceValues(forKeys: [.isSymbolicLinkKey])
        guard releaseRoot == expectedRoot,
              rootValues?.isSymbolicLink != true,
              canonicalRoot.deletingLastPathComponent() == canonicalReleases,
              canonicalRoot.lastPathComponent == binding.releaseID,
              binding.releaseID.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/) != nil,
              binding.compatibility == .caddieCurrent else {
            throw ReleaseRuntimeFault.malformedLaunchRecord
        }
        for (name, artifact) in [("Node", binding.node), ("Tool", binding.tool), ("Skill", binding.skill)] {
            guard !artifact.version.isEmpty,
                  artifact.fingerprint.wholeMatch(of: /^[a-f0-9]{64}$/) != nil else {
                throw ReleaseRuntimeFault.malformedLaunchRecord
            }
            let url = URL(fileURLWithPath: artifact.path).standardizedFileURL
            let resolvedURL = url.resolvingSymlinksInPath()
            guard url.path.hasPrefix(releaseRoot.path + "/") else { throw ReleaseRuntimeFault.missingArtifact(name) }
            let relative = String(url.path.dropFirst(releaseRoot.path.count + 1))
            let expectedResolved = canonicalRoot.appendingPathComponent(relative).standardizedFileURL
            guard resolvedURL == expectedResolved,
                  fileManager.fileExists(atPath: url.path) else {
                throw ReleaseRuntimeFault.missingArtifact(name)
            }
            let actual: String
            do { actual = try ReleaseFingerprint.digest(at: url, fileManager: fileManager) }
            catch ReleaseFingerprintFault.symbolicLink { throw ReleaseRuntimeFault.symbolicLinkArtifact(name) }
            guard actual == artifact.fingerprint else {
                throw ReleaseRuntimeFault.fingerprintMismatch(name)
            }
        }
    }

    private func readLaunchRecord() throws -> ToolLaunchRecord {
        guard fileManager.fileExists(atPath: launchRecordURL.path) else { throw ReleaseRuntimeFault.missingLaunchRecord }
        do {
            guard try launchRecordURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else {
                throw ReleaseRuntimeFault.malformedLaunchRecord
            }
            let data = try Data(contentsOf: launchRecordURL)
            try StrictJSON.validateLaunchRecord(data)
            let record = try decoder.decode(ToolLaunchRecord.self, from: data)
            guard record.version == 1, record.revision > 0 else { throw ReleaseRuntimeFault.malformedLaunchRecord }
            try migrateBackgroundFileProtection(at: launchRecordURL, fileManager: fileManager)
            return record
        } catch let fault as ReleaseRuntimeFault { throw fault }
        catch { throw ReleaseRuntimeFault.malformedLaunchRecord }
    }

    private func writeLaunchRecord(_ record: ToolLaunchRecord) throws {
        try prepareRoots()
        try encoder.encode(record).write(to: launchRecordURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func processIsAlive(_ processID: Int32) -> Bool {
        guard processID > 0 else { return false }
        return kill(processID, 0) == 0 || errno == EPERM
    }

    private func hasLiveLeases() throws -> Bool {
        try !liveLeasesRemovingDead().isEmpty
    }

    private func liveLeasesRemovingDead() throws -> [ToolLease] {
        var live: [ToolLease] = []
        for leaseURL in try fileManager.contentsOfDirectory(at: leasesRoot, includingPropertiesForKeys: nil) {
            guard leaseURL.pathExtension == "json" else { continue }
            let data: Data
            do {
                data = try Data(contentsOf: leaseURL)
            } catch {
                if fileWasRemoved(error) { continue }
                throw ReleaseRuntimeFault.malformedLease
            }
            guard (try? StrictJSON.validateLease(data)) != nil,
                  let lease = try? decoder.decode(ToolLease.self, from: data),
                  lease.version == 1,
                  lease.processID > 0,
                  lease.releaseID.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/) != nil else {
                throw ReleaseRuntimeFault.malformedLease
            }
            do {
                try migrateBackgroundFileProtection(at: leaseURL, fileManager: fileManager)
            } catch {
                if fileWasRemoved(error) { continue }
                throw error
            }
            if processIsAlive(lease.processID) {
                live.append(lease)
            } else {
                do {
                    try fileManager.removeItem(at: leaseURL)
                } catch {
                    if fileWasRemoved(error) { continue }
                    throw error
                }
            }
        }
        return live
    }

    private func protectedReleaseIDs(record: ToolLaunchRecord? = nil) throws -> Set<String> {
        let launchRecord = record ?? (try? readLaunchRecord())
        var protected = Set<String>()
        if let launchRecord {
            protected.formUnion([launchRecord.active.releaseID, launchRecord.lastGood.releaseID])
        }
        protected.formUnion(try liveLeasesRemovingDead().map(\.releaseID))
        return protected
    }
}

private func fileWasRemoved(_ error: Error) -> Bool {
    let error = error as NSError
    let cocoaMissingCodes = [
        CocoaError.fileNoSuchFile.rawValue,
        CocoaError.fileReadNoSuchFile.rawValue,
    ]
    return (error.domain == NSCocoaErrorDomain && cocoaMissingCodes.contains(error.code))
        || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
}
