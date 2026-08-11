import Combine
import ServiceManagement
import XCTest
@testable import CaddieMacAppCore

final class MenuCacheTests: XCTestCase {
    @MainActor
    func testReadingMenuSnapshotDoesNotCallToolOrInspectFiles() async {
        let tool = CountingTool()
        let defaults = UserDefaults(suiteName: "MenuCacheTests-\(UUID().uuidString)")!
        let model = AppModel(client: tool, defaults: defaults, loginItem: DisabledLoginItem())

        XCTAssertEqual(model.menuSnapshot, .empty)
        XCTAssertEqual(model.menuSnapshot.sources, [])
        let callCount = await tool.count()
        XCTAssertEqual(callCount, 0)
    }

    @MainActor
    func testInventoryPresentationPublishesAStatusRefresh() async {
        let live = AppSnapshot(
            version: 2, state: "ready", revision: 2,
            freshness: .init(checkedAt: "2026-08-11T19:46:51Z"),
            summary: .init(selections: 1, current: 1, ready: 0, attention: 0),
            sources: [], userSkills: [], projectSkills: [],
            skillInventory: [.init(
                version: 2, id: "live-skill", scope: "user", projectRoot: nil, name: "Live Skill",
                installedPath: "/tmp/live-skill", enabled: true, managed: false, selectionId: nil,
                origin: nil, shadowsSkillId: nil, status: "unmanaged", permissionFolder: nil
            )],
            projects: [], readyWork: [], authorizations: [], attention: [], recentAttention: [], activity: [],
            pendingActions: [], outsideEffects: [], pause: .init(active: false, reason: nil, safetyTriggered: false),
            watchSet: [], recovery: nil, continuations: []
        )
        let model = AppModel(client: CountingTool(statusResult: live), defaults: testDefaults(), loginItem: DisabledLoginItem())
        let refreshed = expectation(description: "inventory presentation refreshes")
        let observation = model.$inventoryPresentation.dropFirst().sink { presentation in
            if presentation.userSkills.map(\.name) == ["Live Skill"] { refreshed.fulfill() }
        }

        model.start()
        await fulfillment(of: [refreshed], timeout: 1)
        _ = observation
    }

    @MainActor
    func testSuccessfulToolStatusClearsAnOlderErrorBeforeTheNextCycleFinishes() async {
        let tool = SuspendingCycleTool(statusResult: snapshot(safetyPaused: false))
        let model = AppModel(
            client: tool, defaults: testDefaults(), loginItem: DisabledLoginItem(),
            toolStateRoot: FileManager.default.temporaryDirectory
                .appendingPathComponent("caddie-stale-error-\(UUID().uuidString)", isDirectory: true)
        )
        await model.invoke(actionID: "expected-failure")
        XCTAssertNotNil(model.lastError)

        model.start()
        for _ in 0..<1_000 where model.menuSnapshot.revision != 2 { await Task.yield() }

        XCTAssertEqual(model.menuSnapshot.revision, 2)
        XCTAssertNil(model.lastError)
        await tool.resumeCycle()
    }

    @MainActor
    func testOlderSuccessfulStatusDoesNotClearANewerActionError() async {
        let tool = SuspendingStatusTool(statusResult: snapshot(safetyPaused: false))
        let model = AppModel(client: tool, defaults: testDefaults(), loginItem: DisabledLoginItem())

        model.start()
        await tool.waitUntilStatusStarts()
        await model.invoke(actionID: "expected-failure")
        let newerError = model.lastError
        await tool.resumeStatus()
        for _ in 0..<1_000 where model.menuSnapshot.revision != 2 { await Task.yield() }

        XCTAssertEqual(model.menuSnapshot.revision, 2)
        XCTAssertEqual(model.lastError, newerError)
    }

    @MainActor
    func testAutomaticUpdatePausePersistsAsAnAppSchedulingChoice() async {
        let defaults = UserDefaults(suiteName: "MenuPauseTests-\(UUID().uuidString)")!
        let first = AppModel(client: CountingTool(), defaults: defaults, loginItem: DisabledLoginItem())
        await first.toggleAutomaticUpdates()

        let reopened = AppModel(client: CountingTool(), defaults: defaults, loginItem: DisabledLoginItem())
        XCTAssertTrue(reopened.automaticUpdatesPaused)
    }

    @MainActor
    func testLocalPauseResumesWithoutCallingToolSafetyResume() async {
        let defaults = testDefaults()
        defaults.set(true, forKey: "automaticUpdatesPaused")
        let tool = CountingTool()
        let model = AppModel(client: tool, defaults: defaults, loginItem: DisabledLoginItem())

        await model.toggleAutomaticUpdates()

        XCTAssertFalse(model.automaticUpdatesPaused)
        XCTAssertFalse(model.updatesPaused)
        let resumeCount = await tool.resumeCount()
        XCTAssertEqual(resumeCount, 0)
    }

    @MainActor
    func testToolSafetyPauseResumesThroughTool() async {
        let tool = CountingTool(resumeResult: .success(snapshot(safetyPaused: false)))
        let model = AppModel(
            client: tool, defaults: testDefaults(), loginItem: DisabledLoginItem(),
            initialSnapshot: snapshot(safetyPaused: true)
        )

        await model.toggleAutomaticUpdates()

        XCTAssertFalse(model.menuSnapshot.pause.active)
        XCTAssertFalse(model.updatesPaused)
        let resumeCount = await tool.resumeCount()
        XCTAssertEqual(resumeCount, 1)
    }

    @MainActor
    func testOneResumeClearsBothLocalAndToolPause() async {
        let defaults = testDefaults()
        defaults.set(true, forKey: "automaticUpdatesPaused")
        let tool = CountingTool(resumeResult: .success(snapshot(safetyPaused: false)))
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: DisabledLoginItem(),
            initialSnapshot: snapshot(safetyPaused: true)
        )

        await model.toggleAutomaticUpdates()

        XCTAssertFalse(model.automaticUpdatesPaused)
        XCTAssertFalse(model.menuSnapshot.pause.active)
        XCTAssertFalse(model.updatesPaused)
        let resumeCount = await tool.resumeCount()
        XCTAssertEqual(resumeCount, 1)
    }

    @MainActor
    func testFailedToolResumeLeavesSafetyPauseVisibleAfterClearingLocalPause() async {
        let defaults = testDefaults()
        defaults.set(true, forKey: "automaticUpdatesPaused")
        let tool = CountingTool(resumeResult: .failure(TestFault.resumeFailed))
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: DisabledLoginItem(),
            initialSnapshot: snapshot(safetyPaused: true)
        )

        await model.toggleAutomaticUpdates()

        XCTAssertFalse(model.automaticUpdatesPaused)
        XCTAssertTrue(model.menuSnapshot.pause.active)
        XCTAssertTrue(model.updatesPaused)
        XCTAssertTrue(model.lastError?.contains("still safety paused") == true)
        let resumeCount = await tool.resumeCount()
        XCTAssertEqual(resumeCount, 1)
    }

    @MainActor
    func testLoginItemStatusCanRefreshAfterActivationOrWake() {
        let login = MutableLoginItem()
        let model = AppModel(client: CountingTool(), defaults: testDefaults(), loginItem: login)
        XCTAssertEqual(model.loginItemStatus, .notRegistered)

        login.currentStatus = .enabled
        model.refreshLoginStatus()

        XCTAssertEqual(model.loginItemStatus, .enabled)
    }

    @MainActor
    func testPreparingForRemovalTurnsOffLoginWithoutChangingToolOrSkillState() async {
        let login = MutableLoginItem()
        login.currentStatus = .enabled
        let tool = CountingTool()
        let model = AppModel(client: tool, defaults: testDefaults(), loginItem: login)

        XCTAssertTrue(model.prepareForAppRemoval())

        XCTAssertEqual(login.requestedValues, [false])
        let count = await tool.count()
        XCTAssertEqual(count, 0)
    }

    func testVerificationIgnoresOnlyCycleBookkeeping() {
        let prior = snapshot(safetyPaused: false)
        let bookkeepingOnly = AppSnapshot(
            version: prior.version, state: prior.state, revision: prior.revision + 1,
            freshness: .init(checkedAt: "2026-08-03T14:01:00Z"), summary: prior.summary,
            sources: prior.sources, userSkills: prior.userSkills, projectSkills: prior.projectSkills,
            skillInventory: prior.skillInventory, projects: prior.projects,
            readyWork: prior.readyWork, authorizations: prior.authorizations, attention: prior.attention,
            recentAttention: prior.recentAttention, activity: prior.activity, pendingActions: prior.pendingActions,
            outsideEffects: prior.outsideEffects, pause: prior.pause, watchSet: prior.watchSet, recovery: prior.recovery,
            continuations: prior.continuations
        )

        XCTAssertFalse(bookkeepingOnly.hasInspectionRelevantChanges(comparedTo: prior))
        XCTAssertTrue(snapshot(safetyPaused: true).hasInspectionRelevantChanges(comparedTo: prior))
    }

    private func testDefaults() -> UserDefaults {
        UserDefaults(suiteName: "MenuPauseTests-\(UUID().uuidString)")!
    }

    private func snapshot(safetyPaused: Bool) -> AppSnapshot {
        AppSnapshot(
            version: 2, state: "ready", revision: safetyPaused ? 1 : 2,
            freshness: .init(checkedAt: "2026-08-03T14:00:00Z"),
            summary: .init(selections: 0, current: 0, ready: 0, attention: safetyPaused ? 1 : 0),
            sources: [], userSkills: [], projectSkills: [], skillInventory: [], projects: [], readyWork: [], authorizations: [], attention: [], recentAttention: [], activity: [],
            pendingActions: [], outsideEffects: [],
            pause: .init(active: safetyPaused, reason: safetyPaused ? "verification-failed" : nil, safetyTriggered: safetyPaused),
            watchSet: [], recovery: nil, continuations: []
        )
    }
}

private actor CountingTool: ToolCalling {
    private(set) var callCount = 0
    private var safetyResumeCount = 0
    private let statusResult: AppSnapshot
    private let resumeResult: Result<AppSnapshot, TestFault>
    init(
        statusResult: AppSnapshot = .empty,
        resumeResult: Result<AppSnapshot, TestFault> = .success(.empty)
    ) {
        self.statusResult = statusResult
        self.resumeResult = resumeResult
    }
    func status() async throws -> AppSnapshot { callCount += 1; return statusResult }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { callCount += 1; return statusResult }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { callCount += 1; return .empty }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { callCount += 1; return .empty }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot { callCount += 1; return .empty }
    func requestResume() async throws -> AppSnapshot {
        callCount += 1
        safetyResumeCount += 1
        return try resumeResult.get()
    }
    func count() -> Int { callCount }
    func resumeCount() -> Int { safetyResumeCount }
}

private actor SuspendingCycleTool: ToolCalling {
    private let statusResult: AppSnapshot
    private var cycleContinuation: CheckedContinuation<Void, Never>?
    private var resumeRequested = false

    init(statusResult: AppSnapshot) { self.statusResult = statusResult }

    func status() async throws -> AppSnapshot { statusResult }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot {
        if resumeRequested { resumeRequested = false }
        else { await withCheckedContinuation { cycleContinuation = $0 } }
        return statusResult
    }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { statusResult }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { throw TestFault.resumeFailed }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot { statusResult }
    func requestResume() async throws -> AppSnapshot { statusResult }
    func resumeCycle() {
        if let cycleContinuation { cycleContinuation.resume(); self.cycleContinuation = nil }
        else { resumeRequested = true }
    }
}

private actor SuspendingStatusTool: ToolCalling {
    private let statusResult: AppSnapshot
    private var statusContinuation: CheckedContinuation<Void, Never>?
    private var statusStarted = false

    init(statusResult: AppSnapshot) { self.statusResult = statusResult }

    func status() async throws -> AppSnapshot {
        statusStarted = true
        await withCheckedContinuation { statusContinuation = $0 }
        return statusResult
    }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { statusResult }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { statusResult }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { throw TestFault.resumeFailed }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot { statusResult }
    func requestResume() async throws -> AppSnapshot { statusResult }
    func waitUntilStatusStarts() async {
        while !statusStarted { await Task.yield() }
    }
    func resumeStatus() { statusContinuation?.resume(); statusContinuation = nil }
}

private enum TestFault: Error { case resumeFailed }

@MainActor
private struct DisabledLoginItem: LoginItemManaging {
    var status: SMAppService.Status { .notRegistered }
    func setEnabled(_ enabled: Bool) throws {}
    func openSystemSettings() {}
}

@MainActor
private final class MutableLoginItem: LoginItemManaging {
    var currentStatus: SMAppService.Status = .notRegistered
    var requestedValues: [Bool] = []
    var status: SMAppService.Status { currentStatus }
    func setEnabled(_ enabled: Bool) throws {
        requestedValues.append(enabled)
        currentStatus = enabled ? .enabled : .notRegistered
    }
    func openSystemSettings() {}
}
