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

    private func testDefaults() -> UserDefaults {
        UserDefaults(suiteName: "MenuPauseTests-\(UUID().uuidString)")!
    }

    private func snapshot(safetyPaused: Bool) -> AppSnapshot {
        AppSnapshot(
            version: 2, state: "ready", revision: safetyPaused ? 1 : 2,
            freshness: .init(checkedAt: "2026-08-03T14:00:00Z"),
            summary: .init(selections: 0, current: 0, ready: 0, attention: safetyPaused ? 1 : 0),
            sources: [], userSkills: [], projectSkills: [], readyWork: [], authorizations: [], attention: [], recentAttention: [], activity: [],
            pendingActions: [], outsideEffects: [],
            pause: .init(active: safetyPaused, reason: safetyPaused ? "verification-failed" : nil, safetyTriggered: safetyPaused),
            watchSet: [], recovery: nil
        )
    }
}

private actor CountingTool: ToolCalling {
    private(set) var callCount = 0
    private var safetyResumeCount = 0
    private let resumeResult: Result<AppSnapshot, TestFault>
    init(resumeResult: Result<AppSnapshot, TestFault> = .success(.empty)) { self.resumeResult = resumeResult }
    func status() async throws -> AppSnapshot { callCount += 1; return .empty }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { callCount += 1; return .empty }
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
