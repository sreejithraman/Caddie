import Darwin
import Foundation
import XCTest
@testable import CaddieReleaseRuntime

final class CaddieReleaseRuntimeTests: XCTestCase {
    func testStagesChecksAndAtomicallySwitchesActiveAndLastGood() async throws {
        let fixture = try Fixture()
        let first = try fixture.makeRelease(id: "1.0.0")
        let second = try fixture.makeRelease(id: "1.1.0")
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let supportPath = fixture.support.path

        let firstRecord = try await runtime.stageCheckAndActivate(release: first) { binding in
            XCTAssertEqual(binding.releaseID, "1.0.0")
        }
        XCTAssertEqual(firstRecord.active.releaseID, "1.0.0")
        XCTAssertEqual(firstRecord.lastGood.releaseID, "1.0.0")

        let secondRecord = try await runtime.stageCheckAndActivate(release: second) { binding in
            XCTAssertTrue(binding.node.path.hasPrefix(supportPath))
            XCTAssertTrue(binding.tool.path.hasPrefix(supportPath))
        }
        XCTAssertEqual(secondRecord.revision, 2)
        XCTAssertEqual(secondRecord.active.releaseID, "1.1.0")
        XCTAssertEqual(secondRecord.lastGood.releaseID, "1.0.0")
        let checkedSecond = try await runtime.checkedLaunchRecord()
        XCTAssertEqual(checkedSecond, secondRecord)
        XCTAssertTrue(FileManager.default.fileExists(atPath: secondRecord.lastGood.tool.path))
    }

    func testBadFingerprintAndFailedStatusCannotReplaceActive() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "good")) { _ in }
        let original = try await runtime.checkedLaunchRecord()

        let bad = try fixture.makeRelease(id: "bad-fingerprint")
        try Data("changed".utf8).write(to: bad.appendingPathComponent("tool.mjs"))
        await XCTAssertThrowsFault(.fingerprintMismatch("Tool")) {
            _ = try await runtime.stageCheckAndActivate(release: bad) { _ in }
        }
        let afterFingerprintFailure = try await runtime.checkedLaunchRecord()
        XCTAssertEqual(afterFingerprintFailure, original)

        let failed = try fixture.makeRelease(id: "bad-status")
        do {
            _ = try await runtime.stageCheckAndActivate(release: failed) { _ in throw StatusFault.failed }
            XCTFail("status failure should stop activation")
        } catch let fault as ReleaseRuntimeFault {
            guard case .statusCheckFailed = fault else { return XCTFail("unexpected fault: \(fault)") }
        }
        let afterStatusFailure = try await runtime.checkedLaunchRecord()
        XCTAssertEqual(afterStatusFailure, original)
    }

    func testEveryDurableActivationStepLeavesThePriorRecordUsable() async throws {
        for step in CaddieReleaseRuntime.Step.allCases {
            let fixture = try Fixture()
            let initialRuntime = CaddieReleaseRuntime(supportRoot: fixture.support)
            _ = try await initialRuntime.stageCheckAndActivate(release: fixture.makeRelease(id: "old")) { _ in }
            let crashingRuntime = CaddieReleaseRuntime(supportRoot: fixture.support) { observed in
                if observed == step { throw SimulatedCrash() }
            }
            do {
                _ = try await crashingRuntime.stageCheckAndActivate(release: fixture.makeRelease(id: "new")) { _ in }
                XCTFail("\(step.rawValue) should stop the attempt")
            } catch is SimulatedCrash {}

            let restarted = CaddieReleaseRuntime(supportRoot: fixture.support)
            let record = try await restarted.checkedLaunchRecord()
            XCTAssertTrue(["old", "new"].contains(record.active.releaseID), step.rawValue)
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.active.tool.path), step.rawValue)
            XCTAssertNoThrow(try Data(contentsOf: fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName)))
        }
    }

    func testHardProcessDeathAtEveryDurableStepLeavesExactlyOldOrNewActive() async throws {
        let executable = try crashFixtureExecutable()
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path), executable.path)
        for step in CaddieReleaseRuntime.Step.allCases {
            let fixture = try Fixture()
            let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
            _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "old")) { _ in }
            let source = try fixture.makeRelease(id: "new")
            let process = Process()
            process.executableURL = executable
            process.arguments = [fixture.support.path, source.path, step.rawValue]
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 86, step.rawValue)

            let restarted = CaddieReleaseRuntime(supportRoot: fixture.support)
            let record = try await restarted.checkedLaunchRecord()
            XCTAssertEqual(record.active.releaseID, step == .switchedLaunchRecord ? "new" : "old", step.rawValue)
            XCTAssertTrue(FileManager.default.fileExists(atPath: record.active.tool.path), step.rawValue)
        }
    }

    func testUnconfirmedReleaseNeverAdvancesLastGood() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "first")) { _ in }
        _ = try await runtime.confirmActiveAsLastGood { _ in }
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "middle")) { _ in }
        let third = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "third")) { _ in }
        XCTAssertEqual(third.active.releaseID, "third")
        XCTAssertEqual(third.lastGood.releaseID, "first")

        let fallback = try await runtime.ensureUsableActive { binding in
            if binding.releaseID == "third" { throw StatusFault.failed }
        }
        XCTAssertEqual(fallback.active.releaseID, "first")
    }

    func testCleanupReturnsBusyWhileStatusAwaitsAndKeepsTheCandidate() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "old")) { _ in }
        let gate = StatusGate()
        let source = try fixture.makeRelease(id: "candidate")
        let activation = Task {
            try await runtime.stageCheckAndActivate(release: source) { _ in await gate.wait() }
        }
        while !(await gate.hasStarted) { try await Task.sleep(for: .milliseconds(5)) }
        do {
            _ = try await runtime.cleanUnusedReleases()
            XCTFail("cleanup should not wait on its own actor's lifecycle claim")
        } catch let fault as ReleaseRuntimeFault {
            XCTAssertEqual(fault, .lifecycleClaimBusy)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.support.appendingPathComponent("Releases/candidate/tool.mjs").path))
        await gate.open()
        _ = try await activation.value
    }

    func testStartupFallsBackBeforeManagedStateChanges() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "last-good")) { _ in }
        let current = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "current")) { _ in }
        let managedState = fixture.root.appendingPathComponent("managed-state.json")
        try Data("unchanged".utf8).write(to: managedState)

        let fallback = try await runtime.ensureUsableActive { binding in
            if binding.releaseID == "current" { throw StatusFault.failed }
        }
        XCTAssertEqual(current.lastGood.releaseID, "last-good")
        XCTAssertEqual(fallback.active.releaseID, "last-good")
        XCTAssertEqual(fallback.lastGood.releaseID, "last-good")
        XCTAssertEqual(String(decoding: try Data(contentsOf: managedState), as: UTF8.self), "unchanged")
    }

    func testStatusCannotAlterActiveOrLastGoodBytesBeforeReturnOrFallback() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "good")) { _ in }
        _ = try await runtime.confirmActiveAsLastGood { _ in }
        let current = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "current")) { _ in }
        let fallback = try await runtime.ensureUsableActive { binding in
            if binding.releaseID == "current" {
                try Data("tampered".utf8).write(to: URL(fileURLWithPath: binding.tool.path))
            }
        }
        XCTAssertEqual(current.lastGood.releaseID, "good")
        XCTAssertEqual(fallback.active.releaseID, "good")
    }

    func testRetentionKeepsActiveLastGoodAndLiveOldRelease() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let oldest = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "oldest")) { _ in }.active
        _ = try await runtime.confirmActiveAsLastGood { _ in }
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "last-good")) { _ in }
        _ = try await runtime.confirmActiveAsLastGood { _ in }
        let newest = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "active")) { _ in }
        let liveLease = try await runtime.acquireLease(for: oldest, processID: getpid())

        let removedWhileLive = try await runtime.cleanUnusedReleases()
        XCTAssertEqual(removedWhileLive, [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: oldest.releasePath))
        try await runtime.releaseLease(liveLease)
        let removedAfterExit = try await runtime.cleanUnusedReleases()
        XCTAssertEqual(removedAfterExit, ["oldest"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: newest.active.releasePath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: newest.lastGood.releasePath))
    }

    func testIdleLifecycleReservationDrainsAnExistingLeaseAndBlocksANewLease() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let binding = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "current")) { _ in }.active
        let existing = try await runtime.acquireLease(for: binding, processID: getpid())
        let idleTask = Task { try await runtime.acquireIdleLifecycleReservation() }
        let lock = fixture.support.appendingPathComponent("Release Lifecycle.lock", isDirectory: true)
        while !FileManager.default.fileExists(atPath: lock.path) {
            try await Task.sleep(for: .milliseconds(5))
        }

        let contender = LeaseAttemptState()
        let newLeaseTask = Task {
            await contender.didStart()
            let lease = try await CaddieReleaseRuntime(supportRoot: fixture.support)
                .acquireLease(for: binding, processID: getpid())
            await contender.didAcquire()
            return lease
        }
        while !(await contender.started) { try await Task.sleep(for: .milliseconds(5)) }
        try await Task.sleep(for: .milliseconds(60))
        var contenderAcquired = await contender.acquired
        XCTAssertFalse(contenderAcquired)

        try await runtime.releaseLease(existing)
        let idle = try await idleTask.value
        contenderAcquired = await contender.acquired
        XCTAssertFalse(contenderAcquired)
        idle.release()

        let next = try await newLeaseTask.value
        contenderAcquired = await contender.acquired
        XCTAssertTrue(contenderAcquired)
        try await runtime.releaseLease(next)
    }

    func testIdleLifecycleReservationReleasesItsClaimOnCancellationAndMalformedLease() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let binding = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "current")) { _ in }.active
        let lease = try await runtime.acquireLease(for: binding, processID: getpid())
        let lock = fixture.support.appendingPathComponent("Release Lifecycle.lock", isDirectory: true)
        let waiting = Task { try await runtime.acquireIdleLifecycleReservation() }
        while !FileManager.default.fileExists(atPath: lock.path) {
            try await Task.sleep(for: .milliseconds(5))
        }
        waiting.cancel()
        do {
            _ = try await waiting.value
            XCTFail("cancellation should stop the idle reservation")
        } catch is CancellationError {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
        try await runtime.releaseLease(lease)

        let malformed = fixture.support.appendingPathComponent("Leases/bad.json")
        try Data("not json".utf8).write(to: malformed)
        await XCTAssertThrowsFault(.malformedLease) {
            _ = try await runtime.acquireIdleLifecycleReservation()
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
    }

    func testIdleLifecycleReservationAcceptsALeaseRemovedAfterEnumeration() async throws {
        let fixture = try Fixture()
        let owner = CaddieReleaseRuntime(supportRoot: fixture.support)
        let binding = try await owner.stageCheckAndActivate(release: fixture.makeRelease(id: "current")) { _ in }.active
        let fileManager = VanishingLeaseFileManager(point: .afterEnumeration)
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support, fileManager: fileManager)
        let lease = try await runtime.acquireLease(for: binding, processID: getpid())

        let idle = try await runtime.acquireIdleLifecycleReservation()
        idle.release()
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: fixture.support.appendingPathComponent("Leases/\(lease.id.uuidString).json").path
        ))
    }

    func testIdleLifecycleReservationAcceptsADeadLeaseRemovedBeforeCleanup() async throws {
        let fixture = try Fixture()
        let leases = fixture.support.appendingPathComponent("Leases", isDirectory: true)
        try FileManager.default.createDirectory(at: leases, withIntermediateDirectories: true)
        let lease = ToolLease(id: UUID(), releaseID: "current", processID: Int32.max, createdAt: Date())
        try JSONEncoder.caddie.encode(lease).write(to: leases.appendingPathComponent("\(lease.id.uuidString).json"))
        let fileManager = VanishingLeaseFileManager(point: .beforeDeadLeaseRemoval)
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support, fileManager: fileManager)

        let idle = try await runtime.acquireIdleLifecycleReservation()
        idle.release()
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: leases.appendingPathComponent("\(lease.id.uuidString).json").path
        ))
    }

    func testMissingMalformedAndUnsafeManifestsDoNotCreateManagedState() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let missing = fixture.root.appendingPathComponent("missing", isDirectory: true)
        try FileManager.default.createDirectory(at: missing, withIntermediateDirectories: true)
        await XCTAssertThrowsFault(.missingManifest) {
            _ = try await runtime.stageCheckAndActivate(release: missing) { _ in }
        }

        let malformed = fixture.root.appendingPathComponent("malformed", isDirectory: true)
        try FileManager.default.createDirectory(at: malformed, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: malformed.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        await XCTAssertThrowsFault(.malformedManifest) {
            _ = try await runtime.stageCheckAndActivate(release: malformed) { _ in }
        }

        let unsafe = try fixture.makeRelease(id: "unsafe")
        var manifest = try JSONDecoder().decode(
            CaddieReleaseManifest.self,
            from: Data(contentsOf: unsafe.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        )
        manifest = CaddieReleaseManifest(
            releaseID: manifest.releaseID,
            app: ReleaseArtifact(version: manifest.app.version, path: "../outside", fingerprint: manifest.app.fingerprint),
            node: manifest.node, tool: manifest.tool, skill: manifest.skill, compatibility: manifest.compatibility
        )
        try JSONEncoder().encode(manifest).write(to: unsafe.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        await XCTAssertThrowsFault(.invalidArtifactPath("../outside")) {
            _ = try await runtime.stageCheckAndActivate(release: unsafe) { _ in }
        }
        let nestedTraversal = try fixture.makeRelease(id: "nested-traversal")
        manifest = try JSONDecoder().decode(
            CaddieReleaseManifest.self,
            from: Data(contentsOf: nestedTraversal.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        )
        manifest = CaddieReleaseManifest(
            releaseID: manifest.releaseID,
            app: ReleaseArtifact(version: manifest.app.version, path: "parts/../Caddie.app", fingerprint: manifest.app.fingerprint),
            node: manifest.node, tool: manifest.tool, skill: manifest.skill, compatibility: manifest.compatibility
        )
        try JSONEncoder().encode(manifest).write(to: nestedTraversal.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        await XCTAssertThrowsFault(.invalidArtifactPath("parts/../Caddie.app")) {
            _ = try await runtime.stageCheckAndActivate(release: nestedTraversal) { _ in }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName).path))
    }

    func testSymlinkArtifactIsRejectedBeforeStatusAndMalformedLeaseStopsCleanup() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let linked = try fixture.makeRelease(id: "linked")
        let tool = linked.appendingPathComponent("tool.mjs")
        try FileManager.default.removeItem(at: tool)
        try FileManager.default.createSymbolicLink(at: tool, withDestinationURL: linked.appendingPathComponent("node"))
        await XCTAssertThrowsFault(.symbolicLinkArtifact("Tool")) {
            _ = try await runtime.stageCheckAndActivate(release: linked) { _ in XCTFail("status must not run") }
        }

        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "good")) { _ in }
        let leases = fixture.support.appendingPathComponent("Leases", isDirectory: true)
        try Data("bad lease".utf8).write(to: leases.appendingPathComponent("unknown.json"))
        do {
            _ = try await runtime.cleanUnusedReleases()
            XCTFail("malformed lease must stop cleanup")
        } catch let fault as ReleaseRuntimeFault {
            XCTAssertEqual(fault, .malformedLease)
        }
    }

    func testStrictJSONRejectsExtensionsInManifestLaunchRecordAndLease() async throws {
        let manifestFixture = try Fixture()
        let manifestRuntime = CaddieReleaseRuntime(supportRoot: manifestFixture.support)
        let source = try manifestFixture.makeRelease(id: "manifest-extra")
        let manifestURL = source.appendingPathComponent(CaddieReleaseRuntime.manifestName)
        var manifestJSON = try jsonObject(manifestURL)
        manifestJSON["future"] = true
        try writeJSONObject(manifestJSON, to: manifestURL)
        await XCTAssertThrowsFault(.malformedManifest) {
            _ = try await manifestRuntime.stageCheckAndActivate(release: source) { _ in }
        }

        let recordFixture = try Fixture()
        let recordRuntime = CaddieReleaseRuntime(supportRoot: recordFixture.support)
        _ = try await recordRuntime.stageCheckAndActivate(release: recordFixture.makeRelease(id: "record-extra")) { _ in }
        let recordURL = recordFixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName)
        var recordJSON = try jsonObject(recordURL)
        var active = recordJSON["active"] as! [String: Any]
        active["future"] = true
        recordJSON["active"] = active
        try writeJSONObject(recordJSON, to: recordURL)
        await XCTAssertThrowsFault(.malformedLaunchRecord) { _ = try await recordRuntime.checkedLaunchRecord() }

        let leaseFixture = try Fixture()
        let leaseRuntime = CaddieReleaseRuntime(supportRoot: leaseFixture.support)
        _ = try await leaseRuntime.stageCheckAndActivate(release: leaseFixture.makeRelease(id: "lease-extra")) { _ in }
        let leases = leaseFixture.support.appendingPathComponent("Leases", isDirectory: true)
        try writeJSONObject([
            "createdAt": "2026-08-03T12:00:00Z", "future": true, "id": UUID().uuidString,
            "processID": getpid(), "releaseID": "lease-extra", "version": 1,
        ], to: leases.appendingPathComponent("extra.json"))
        await XCTAssertThrowsFault(.malformedLease) { _ = try await leaseRuntime.cleanUnusedReleases() }
    }

    func testDamagedUnprotectedReleaseCanRepairButProtectedReleaseCannot() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "stable")) { _ in }
        _ = try await runtime.confirmActiveAsLastGood { _ in }

        let candidateSource = try fixture.makeRelease(id: "candidate")
        do {
            _ = try await runtime.stageCheckAndActivate(release: candidateSource) { _ in throw StatusFault.failed }
        } catch is ReleaseRuntimeFault {}
        let candidateTool = fixture.support.appendingPathComponent("Releases/candidate/tool.mjs")
        try Data("damaged".utf8).write(to: candidateTool)
        let repaired = try await runtime.stageCheckAndActivate(release: candidateSource) { _ in }
        XCTAssertEqual(repaired.active.releaseID, "candidate")
        XCTAssertEqual(String(decoding: try Data(contentsOf: candidateTool), as: UTF8.self), "candidate:tool.mjs")

        try Data("protected damage".utf8).write(to: candidateTool)
        await XCTAssertThrowsFault(.fingerprintMismatch("Tool")) {
            _ = try await runtime.stageCheckAndActivate(release: candidateSource) { _ in }
        }
        XCTAssertEqual(String(decoding: try Data(contentsOf: candidateTool), as: UTF8.self), "protected damage")
    }

    func testActivationVerifiesPriorActiveAndLastGoodBeforeCopyingThePointer() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let first = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "first")) { _ in }
        _ = try await runtime.confirmActiveAsLastGood { _ in }
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "second")) { _ in }
        try Data("damaged last good".utf8).write(to: URL(fileURLWithPath: first.active.tool.path))

        await XCTAssertThrowsFault(.fingerprintMismatch("Tool")) {
            _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "third")) { _ in }
        }
        let raw = try jsonObject(fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName))
        XCTAssertEqual((raw["active"] as! [String: Any])["releaseID"] as? String, "second")
    }

    func testLifecycleClaimRemainsReadableAfterTheFirstLogin() throws {
        let fixture = try Fixture()
        let claim = try acquireLifecycleClaim(supportRoot: fixture.support, fileManager: .default)
        defer { claim.release() }

        let owner = claim.directory.appendingPathComponent("owner.json")
        XCTAssertEqual(
            try owner.resourceValues(forKeys: [.fileProtectionKey]).fileProtection,
            .completeUntilFirstUserAuthentication
        )
        XCTAssertEqual(try readLifecycleOwner(directory: claim.directory).nonce, claim.nonce)
    }

    func testLaunchRecordPublicLeaseAndLifecycleClaimUseBackgroundProtection() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let record = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "protected")) { _ in }
        let launchRecord = fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName)
        XCTAssertEqual(try launchRecord.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)

        let lease = try await runtime.acquireLease(for: record.active, processID: getpid())
        defer { Task { try? await runtime.releaseLease(lease) } }
        let leaseURL = fixture.support.appendingPathComponent("Leases/\(lease.id.uuidString).json")
        XCTAssertEqual(try leaseURL.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)

        let claim = try acquireLifecycleClaim(supportRoot: fixture.root.appendingPathComponent("claim-protection"), fileManager: .default)
        defer { claim.release() }
        let ownerURL = claim.directory.appendingPathComponent("owner.json")
        XCTAssertEqual(try ownerURL.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)
    }

    func testOldProtectionMigratesBeforeLaunchLeaseAndLifecycleReads() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let record = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "migration")) { _ in }
        let launchRecord = fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.none], ofItemAtPath: launchRecord.path)
        _ = try await runtime.checkedLaunchRecord()
        XCTAssertEqual(try launchRecord.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)

        let lease = try await runtime.acquireLease(for: record.active, processID: getpid())
        let leaseURL = fixture.support.appendingPathComponent("Leases/\(lease.id.uuidString).json")
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.none], ofItemAtPath: leaseURL.path)
        _ = try await runtime.cleanUnusedReleases()
        XCTAssertEqual(try leaseURL.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)
        try await runtime.releaseLease(lease)

        let claimRoot = fixture.root.appendingPathComponent("old-claim-protection")
        let claim = try acquireLifecycleClaim(supportRoot: claimRoot, fileManager: .default)
        let ownerURL = claim.directory.appendingPathComponent("owner.json")
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.none], ofItemAtPath: ownerURL.path)
        _ = try readLifecycleOwner(directory: claim.directory)
        XCTAssertEqual(try ownerURL.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)
        claim.release()

        let takeoverRoot = fixture.root.appendingPathComponent("old-takeover-protection")
        try staleLifecycleClaim(at: takeoverRoot)
        let gate = takeoverRoot.appendingPathComponent("Release Lifecycle.takeover", isDirectory: true)
        try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true)
        let owner = LifecycleOwner(version: 1, nonce: UUID(), processID: Int32.max, createdAt: Date())
        let takeoverOwner = gate.appendingPathComponent("owner.json")
        try JSONEncoder.caddie.encode(owner).write(to: takeoverOwner, options: [.noFileProtection])
        XCTAssertThrowsError(try acquireLifecycleClaim(supportRoot: takeoverRoot, fileManager: .default))
        XCTAssertEqual(try takeoverOwner.resourceValues(forKeys: [.fileProtectionKey]).fileProtection, .completeUntilFirstUserAuthentication)
    }

    func testPublicLeaseAndCleanupRaceCannotDeleteALeasedRelease() async throws {
        let fixture = try Fixture()
        let owner = CaddieReleaseRuntime(supportRoot: fixture.support)
        let old = try await owner.stageCheckAndActivate(release: fixture.makeRelease(id: "old")) { _ in }.active
        _ = try await owner.confirmActiveAsLastGood { _ in }
        _ = try await owner.stageCheckAndActivate(release: fixture.makeRelease(id: "new")) { _ in }
        _ = try await owner.confirmActiveAsLastGood { _ in }
        let leaser = CaddieReleaseRuntime(supportRoot: fixture.support)
        let cleaner = CaddieReleaseRuntime(supportRoot: fixture.support)

        async let leaseResult: Result<ToolLease, Error> = {
            do { return .success(try await leaser.acquireLease(for: old, processID: getpid())) }
            catch { return .failure(error) }
        }()
        async let cleanupResult: Result<[String], Error> = {
            do { return .success(try await cleaner.cleanUnusedReleases()) }
            catch { return .failure(error) }
        }()
        let (lease, cleanup) = await (leaseResult, cleanupResult)
        if case .success(let value) = lease {
            XCTAssertTrue(FileManager.default.fileExists(atPath: old.releasePath))
            try await leaser.releaseLease(value)
        } else {
            XCTAssertEqual(try cleanup.get(), ["old"])
        }
    }

    func testStaleTakeoverSerializesTwoContendersWithoutRemovingTheNewOwner() async throws {
        let fixture = try Fixture()
        try staleLifecycleClaim(at: fixture.support)
        let tracker = ClaimTracker()
        let support = fixture.support
        async let first = contendForClaim(root: support, tracker: tracker)
        async let second = contendForClaim(root: support, tracker: tracker)
        let results = await [first, second]
        XCTAssertTrue(results.contains(true))
        let maximum = await tracker.maximum
        XCTAssertLessThanOrEqual(maximum, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.support.appendingPathComponent("Release Lifecycle.takeover").path))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: fixture.support.path)
            .filter { $0.hasPrefix(".release-claim-") }
        XCTAssertEqual(leftovers, [])
    }

    func testIncompleteTakeoverGateFailsClosed() throws {
        let fixture = try Fixture()
        try staleLifecycleClaim(at: fixture.support)
        let gate = fixture.support.appendingPathComponent("Release Lifecycle.takeover", isDirectory: true)
        try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true)
        try Data("bad".utf8).write(to: gate.appendingPathComponent("owner.json"))
        XCTAssertThrowsError(try acquireLifecycleClaim(supportRoot: fixture.support, fileManager: .default)) { error in
            XCTAssertEqual(error as? ReleaseRuntimeFault, .takeoverClaimPresent)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.support.appendingPathComponent("Release Lifecycle.lock").path))
    }

    func testOrphanedTakeoverClaimExposesTypedRepairEvidenceWithoutRemovingIt() async throws {
        let fixture = try Fixture()
        let gate = fixture.support.appendingPathComponent("Release Lifecycle.takeover", isDirectory: true)
        try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true)
        let owner = LifecycleOwner(version: 1, nonce: UUID(), processID: Int32.max, createdAt: Date())
        try JSONEncoder.caddie.encode(owner).write(to: gate.appendingPathComponent("owner.json"))
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        let evidence = try await runtime.inspectTakeoverClaim()
        XCTAssertEqual(evidence?.path, gate.path)
        XCTAssertEqual(evidence?.nonce, owner.nonce)
        XCTAssertEqual(evidence?.processID, owner.processID)
        XCTAssertEqual(evidence?.processIsAlive, false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: gate.path))
    }

    func testReleaseRootReplacementDuringStatusCannotReachLaunchRecordSwitch() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "old")) { _ in }
        let source = try fixture.makeRelease(id: "candidate")
        let external = fixture.root.appendingPathComponent("status-external", isDirectory: true)
        await XCTAssertThrowsFault(.malformedLaunchRecord) {
            _ = try await runtime.stageCheckAndActivate(release: source) { binding in
                let root = URL(fileURLWithPath: binding.releasePath)
                try FileManager.default.copyItem(at: root, to: external)
                try FileManager.default.removeItem(at: root)
                try FileManager.default.createSymbolicLink(at: root, withDestinationURL: external)
            }
        }
        let raw = try jsonObject(fixture.support.appendingPathComponent(CaddieReleaseRuntime.launchRecordName))
        XCTAssertEqual((raw["active"] as! [String: Any])["releaseID"] as? String, "old")
    }

    func testCleanupIgnoresNonJSONFilesAndReleaseRootSymlinkNeverReachesStatus() async throws {
        let fixture = try Fixture()
        let runtime = CaddieReleaseRuntime(supportRoot: fixture.support)
        _ = try await runtime.stageCheckAndActivate(release: fixture.makeRelease(id: "stable")) { _ in }
        let leases = fixture.support.appendingPathComponent("Leases", isDirectory: true)
        try Data("Finder metadata".utf8).write(to: leases.appendingPathComponent(".DS_Store"))
        let finderCleanup = try await runtime.cleanUnusedReleases()
        XCTAssertEqual(finderCleanup, [])

        let source = try fixture.makeRelease(id: "linked-root")
        let releases = fixture.support.appendingPathComponent("Releases", isDirectory: true)
        let external = fixture.root.appendingPathComponent("external-release", isDirectory: true)
        try FileManager.default.copyItem(at: source, to: external)
        try FileManager.default.createSymbolicLink(
            at: releases.appendingPathComponent("linked-root"),
            withDestinationURL: external
        )
        await XCTAssertThrowsFault(.malformedLaunchRecord) {
            _ = try await runtime.stageCheckAndActivate(release: source) { _ in XCTFail("status must not run") }
        }
    }
}

private actor ClaimTracker {
    private var current = 0
    private(set) var maximum = 0
    func enter() { current += 1; maximum = max(maximum, current) }
    func leave() { current -= 1 }
}

private func contendForClaim(root: URL, tracker: ClaimTracker) async -> Bool {
    do {
        let claim = try acquireLifecycleClaim(supportRoot: root, fileManager: .default)
        await tracker.enter()
        try? await Task.sleep(for: .milliseconds(80))
        await tracker.leave()
        claim.release()
        return true
    } catch { return false }
}

private func staleLifecycleClaim(at support: URL) throws {
    try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let temporary = support.appendingPathComponent("stale-temp", isDirectory: true)
    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    let owner = LifecycleOwner(version: 1, nonce: UUID(), processID: Int32.max, createdAt: Date())
    try JSONEncoder.caddie.encode(owner).write(to: temporary.appendingPathComponent("owner.json"))
    try FileManager.default.moveItem(at: temporary, to: support.appendingPathComponent("Release Lifecycle.lock"))
}

private actor StatusGate {
    private(set) var hasStarted = false
    private var isOpen = false

    func wait() async {
        hasStarted = true
        while !isOpen { try? await Task.sleep(for: .milliseconds(5)) }
    }

    func open() { isOpen = true }
}

private func crashFixtureExecutable() throws -> URL {
    let package = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let build = package.appendingPathComponent(".build", isDirectory: true)
    guard let enumerator = FileManager.default.enumerator(at: build, includingPropertiesForKeys: [.isExecutableKey]) else {
        throw FixtureFault.missingCrashExecutable
    }
    for case let candidate as URL in enumerator where candidate.lastPathComponent == "CaddieReleaseCrashFixture" {
        if (try? candidate.resourceValues(forKeys: [.isExecutableKey]).isExecutable) == true { return candidate }
    }
    throw FixtureFault.missingCrashExecutable
}

private enum FixtureFault: Error { case missingCrashExecutable }

private func jsonObject(_ url: URL) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}

private func writeJSONObject(_ value: [String: Any], to url: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url)
}

private struct SimulatedCrash: Error {}
private enum StatusFault: Error { case failed }

private actor LeaseAttemptState {
    private(set) var started = false
    private(set) var acquired = false
    func didStart() { started = true }
    func didAcquire() { acquired = true }
}

private final class VanishingLeaseFileManager: FileManager, @unchecked Sendable {
    enum Point { case afterEnumeration, beforeDeadLeaseRemoval }

    private let point: Point

    init(point: Point) {
        self.point = point
        super.init()
    }

    override func contentsOfDirectory(
        at url: URL,
        includingPropertiesForKeys keys: [URLResourceKey]?,
        options mask: DirectoryEnumerationOptions = []
    ) throws -> [URL] {
        let contents = try super.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: mask)
        if point == .afterEnumeration, url.lastPathComponent == "Leases",
           let lease = contents.first(where: { $0.pathExtension == "json" }) {
            try super.removeItem(at: lease)
        }
        return contents
    }

    override func removeItem(at URL: URL) throws {
        if point == .beforeDeadLeaseRemoval, URL.deletingLastPathComponent().lastPathComponent == "Leases",
           fileExists(atPath: URL.path) {
            try super.removeItem(at: URL)
        }
        try super.removeItem(at: URL)
    }
}

private final class Fixture {
    let root: URL
    let support: URL

    init() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("caddie-release-tests-\(UUID().uuidString)")
        support = root.appendingPathComponent("Application Support", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: root) }

    func makeRelease(id: String) throws -> URL {
        let directory = root.appendingPathComponent("source-\(id)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let paths = ["Caddie.app", "node", "tool.mjs", "skill"]
        for path in paths { try Data("\(id):\(path)".utf8).write(to: directory.appendingPathComponent(path)) }
        func artifact(_ path: String, version: String = "1") throws -> ReleaseArtifact {
            ReleaseArtifact(
                version: version,
                path: path,
                fingerprint: try ReleaseFingerprint.digest(at: directory.appendingPathComponent(path))
            )
        }
        let manifest = try CaddieReleaseManifest(
            releaseID: id,
            app: artifact("Caddie.app"),
            node: artifact("node", version: "22.0.0"),
            tool: artifact("tool.mjs", version: "2.0.0"),
            skill: artifact("skill", version: "2.0.0"),
            compatibility: ReleaseCompatibility(
                toolProtocolVersion: 2,
                supportedSkillProtocolVersions: [1, 2],
                minimumStateFormatVersion: 1,
                maximumStateFormatVersion: 1
            )
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(to: directory.appendingPathComponent(CaddieReleaseRuntime.manifestName))
        return directory
    }
}

private extension XCTestCase {
    func XCTAssertThrowsFault(
        _ expected: ReleaseRuntimeFault,
        operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch let actual as ReleaseRuntimeFault {
            XCTAssertEqual(actual, expected, file: file, line: line)
        } catch {
            XCTFail("unexpected error: \(error)", file: file, line: line)
        }
    }
}
