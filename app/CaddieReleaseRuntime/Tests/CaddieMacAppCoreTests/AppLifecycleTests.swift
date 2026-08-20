import Foundation
import XCTest
@testable import CaddieMacAppCore
import CaddieReleaseRuntime

final class AppLifecycleTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)

    func testReleaseRunsOnlyFromSupportedApplicationsFolders() {
        let policy = AppLocationPolicy()
        XCTAssertEqual(policy.assess(bundleURL: URL(fileURLWithPath: "/Applications/Caddie.app"), homeURL: home, channel: .release), .allowed)
        XCTAssertEqual(policy.assess(bundleURL: URL(fileURLWithPath: "/Users/example/Applications/Caddie.app"), homeURL: home, channel: .release), .allowed)
        XCTAssertEqual(policy.assess(bundleURL: URL(fileURLWithPath: "/Users/example/Desktop/Caddie.app"), homeURL: home, channel: .release), .blocked(.unsupportedFolder))
    }

    func testReleaseBlocksEveryUnsafeFirstLaunchLocation() {
        let policy = AppLocationPolicy()
        let cases: [(String, AppLocationBlock)] = [
            ("/Volumes/Caddie/Caddie.app", .mountedVolume),
            ("/Users/example/Downloads/Caddie.app", .downloads),
            ("/private/var/folders/a/AppTranslocation/xyz/Caddie.app", .appTranslocation),
            ("/private/tmp/Caddie.app", .temporaryFolder),
        ]
        for (path, reason) in cases {
            XCTAssertEqual(policy.assess(bundleURL: URL(fileURLWithPath: path), homeURL: home, channel: .release), .blocked(reason))
        }
    }

    func testReleaseRejectsASymlinkedAppLocation() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        let real = root.appendingPathComponent("real/Caddie.app")
        let link = root.appendingPathComponent("Caddie.app")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(AppLocationPolicy().assess(bundleURL: link, homeURL: home, channel: .release), .blocked(.unsupportedFolder))
    }

    func testDevelopmentBuildUsesSeparateDefaultsAndMayRunFromBuildFolder() {
        let channel = CaddieBuildChannel(bundleIdentifier: "app.caddie.CaddieMenuApp.dev")
        XCTAssertEqual(channel, .development)
        XCTAssertEqual(channel.applicationSupportFolder, "Caddie Development")
        XCTAssertFalse(channel.installsUpdatesAutomaticallyByDefault)
        XCTAssertFalse(channel.startsAtLoginByDefault)
        XCTAssertEqual(AppLocationPolicy().assess(
            bundleURL: URL(fileURLWithPath: "/work/.build/Caddie.app"), homeURL: home, channel: channel
        ), .allowed)
    }

    func testDevelopmentToolUsesIsolatedHomeWhileReleaseKeepsUserEnvironment() {
        let support = URL(fileURLWithPath: "/tmp/Caddie Development", isDirectory: true)
        let base = ["HOME": "/Users/example", "TOKEN": "kept"]

        XCTAssertEqual(
            CaddieBuildChannel.development.toolEnvironment(base: base, supportRoot: support),
            ["HOME": "/tmp/Caddie Development/Developer Home", "TOKEN": "kept"]
        )
        XCTAssertEqual(CaddieBuildChannel.release.toolEnvironment(base: base, supportRoot: support), base)
    }

    func testBootstrapClassifiesAllSixPreservationCases() {
        let policy = BootstrapStatePolicy()
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: false)), .fresh)
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: true, toolSnapshotState: "ready")), .current)
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: true, hasLegacyState: true)), .old)
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: true, recoveryIsActive: true)), .recovery)
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: true, toolErrorCode: "malformed-management-state")), .malformed)
        XCTAssertEqual(policy.classify(.init(hasCaddieStateRoot: true, toolErrorCode: "unsupported-management-state-version")), .newer)
    }


    func testBootstrapCoordinatorPreservesStateAcrossAllSixCases() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("caddie-bootstrap-cases-\(UUID().uuidString)")
        let userState = root.appendingPathComponent("home/.agents/.caddie", isDirectory: true)
        let projectState = root.appendingPathComponent("project/.agents/.caddie", isDirectory: true)
        try FileManager.default.createDirectory(at: userState, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: projectState, withIntermediateDirectories: true)
        let userSentinel = userState.appendingPathComponent("sentinel.json")
        let projectSentinel = projectState.appendingPathComponent("sentinel.json")
        try Data("user-state".utf8).write(to: userSentinel)
        try Data("project-state".utf8).write(to: projectSentinel)
        defer { try? FileManager.default.removeItem(at: root) }
        let before = try [Data(contentsOf: userSentinel), Data(contentsOf: projectSentinel)]
        let coordinator = BootstrapCoordinator()
        let cases: [(BootstrapStateEvidence, BootstrapDisposition)] = [
            (.init(hasCaddieStateRoot: false), .proceedWithoutMovingState),
            (.init(hasCaddieStateRoot: true, toolSnapshotState: "ready"), .proceedWithoutMovingState),
            (.init(hasCaddieStateRoot: true, hasLegacyState: true), .proceedWithoutMovingState),
            (.init(hasCaddieStateRoot: true, recoveryIsActive: true), .requireRecoveryChoice),
            (.init(hasCaddieStateRoot: true, toolErrorCode: "malformed-management-state"), .stopAndPreserveState),
            (.init(hasCaddieStateRoot: true, toolErrorCode: "unsupported-management-state-version"), .stopAndPreserveState),
        ]
        for (evidence, expected) in cases {
            XCTAssertEqual(coordinator.disposition(for: evidence), expected)
            XCTAssertEqual(try Data(contentsOf: userSentinel), before[0])
            XCTAssertEqual(try Data(contentsOf: projectSentinel), before[1])
        }
    }

    func testDownloadedUpdateUsesOneClaimAgainstCurrentAndNewLifecycleWork() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("caddie-update-claim-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let runtime = CaddieReleaseRuntime(supportRoot: root)
        let currentTool = try await runtime.acquireLifecycleReservation()
        let installer = BlockingUpdateInstaller()
        let coordinator = IdleUpdateCoordinator(
            installer: installer,
            lifecycle: FileLifecycleReserver(supportRoot: root)
        )
        let update = Task { try await coordinator.updateReady() }
        try await Task.sleep(for: .milliseconds(60))
        var updateStarted = await installer.started
        XCTAssertFalse(updateStarted)

        currentTool.release()
        while !(await installer.started) { try await Task.sleep(for: .milliseconds(10)) }

        let contender = ReservationResult()
        let newTool = Task {
            let claim = try await CaddieReleaseRuntime(supportRoot: root).acquireLifecycleReservation()
            await contender.didAcquire()
            return claim
        }
        try await Task.sleep(for: .milliseconds(60))
        var contenderAcquired = await contender.acquired
        XCTAssertFalse(contenderAcquired)

        await installer.finish()
        try await update.value
        let next = try await newTool.value
        contenderAcquired = await contender.acquired
        XCTAssertTrue(contenderAcquired)
        next.release()
        updateStarted = await coordinator.hasPendingUpdate
        XCTAssertFalse(updateStarted)
    }

    func testFailedDownloadedUpdateStaysPendingForAnExplicitLaterActivityChange() async throws {
        let installer = UpdateInstallerSpy(failuresRemaining: 1)
        let coordinator = IdleUpdateCoordinator(installer: installer, lifecycle: ImmediateLifecycleReserver())
        do {
            try await coordinator.updateReady()
            XCTFail("The first install should fail")
        } catch {}
        var pending = await coordinator.hasPendingUpdate
        var installs = await installer.count
        XCTAssertTrue(pending)
        XCTAssertEqual(installs, 1)

        try await coordinator.retryPendingUpdate()
        pending = await coordinator.hasPendingUpdate
        installs = await installer.count
        XCTAssertFalse(pending)
        XCTAssertEqual(installs, 2)
    }

    func testRemovalAndZapNeverSelectCaddieStateOrSkills() {
        let policy = AppRemovalPolicy()
        XCTAssertEqual(policy.removablePaths(kind: .appOnly, homeURL: home), [])
        let zap = policy.removablePaths(kind: .homebrewZap, homeURL: home)
        XCTAssertTrue(policy.preservesCaddieState(removing: zap, homeURL: home))
        XCTAssertFalse(policy.preservesCaddieState(
            removing: [home.appendingPathComponent(".agents/.caddie")], homeURL: home
        ))
        XCTAssertFalse(policy.preservesCaddieState(
            removing: [URL(fileURLWithPath: "/project/.agents/.caddie/lock.json")], homeURL: home
        ))
        XCTAssertFalse(policy.preservesCaddieState(
            removing: [home.appendingPathComponent(".agents/skills/caddie")], homeURL: home
        ))
    }

    func testRepairChoicesDoNotRunWorkOnTheirOwn() {
        XCTAssertEqual(RepairChoice.homebrew.command, "brew reinstall --cask caddie")
        let release = URL(string: "https://github.com/example/releases/tag/v1")!
        XCTAssertEqual(RepairChoice.signedRelease(release).url, release)
    }
}

private struct ImmediateLifecycleReserver: LifecycleReserving {
    func reserve() async throws -> any LifecycleReservation { ImmediateLifecycleReservation() }
}

private struct ImmediateLifecycleReservation: LifecycleReservation {
    func release() {}
}

private actor ReservationResult {
    private(set) var acquired = false
    func didAcquire() { acquired = true }
}

private actor BlockingUpdateInstaller: DownloadedUpdateInstalling {
    private(set) var started = false
    private var finished = false

    func installDownloadedUpdate() async {
        started = true
        while !finished { try? await Task.sleep(for: .milliseconds(10)) }
    }

    func finish() { finished = true }
}

private actor UpdateInstallerSpy: DownloadedUpdateInstalling {
    private(set) var count = 0
    private var failuresRemaining: Int

    init(failuresRemaining: Int = 0) {
        self.failuresRemaining = failuresRemaining
    }

    func installDownloadedUpdate() throws {
        count += 1
        if failuresRemaining > 0 {
            failuresRemaining -= 1
            throw NSError(domain: "UpdateInstallerSpy", code: 1)
        }
    }
}
