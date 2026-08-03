import Foundation
import ServiceManagement
import XCTest
@testable import CaddieMacAppCore

final class AppModelActionsTests: XCTestCase {
    @MainActor
    func testNotificationOptInDeliversOnceAndReportsRetriedEffect() async throws {
        let item = attention()
        let effect = notificationEffect()
        let pending = snapshot(attention: [item], effects: [effect])
        let tool = ActionTool(requested: pending, invoked: pending, reported: snapshot())
        let delivery = RecordingNotifications()
        let defaults = UserDefaults(suiteName: "NoticeModel-\(UUID().uuidString)")!
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(), notifications: delivery,
            workspace: RecordingWorkspace(), initialSnapshot: pending
        )

        let before = await delivery.deliveries()
        XCTAssertEqual(before, 0)
        await model.setNotificationsEnabled(true)
        await delivery.waitForDeliveryCount(1)
        await tool.waitForReportCount(1)
        let after = await delivery.deliveries()
        let reports = await tool.reportedEffects()
        XCTAssertEqual(after, 1)
        XCTAssertEqual(reports, ["effect-one"])

        let replay = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(), notifications: delivery,
            workspace: RecordingWorkspace(), initialSnapshot: pending
        )
        await replay.setNotificationsEnabled(true)
        await delivery.waitForDeliveryCount(1)
        let replayed = await delivery.deliveries()
        XCTAssertEqual(replayed, 1, "the stable delivery ID blocks a second notice")
    }

    @MainActor
    func testASecondExplicitHandoffClickReopensAfterTheFirstWasReported() async throws {
        let item = attention()
        let action = pendingHandoff()
        let effect = handoffEffect()
        let tool = ActionTool(
            requested: snapshot(attention: [item], pending: [action]),
            invoked: snapshot(attention: [item], effects: [effect]), reported: snapshot(attention: [item])
        )
        let workspace = RecordingWorkspace()
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "HandoffModel-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: RecordingNotifications(), workspace: workspace,
            initialSnapshot: snapshot(attention: [item])
        )
        XCTAssertEqual(workspace.urls.count, 0)
        await model.handoff(attentionID: "attention-one", provider: .codex)
        await model.handoff(attentionID: "attention-one", provider: .codex)
        XCTAssertEqual(workspace.urls.count, 2)
        let parts = try XCTUnwrap(URLComponents(url: workspace.urls[0], resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "path" })?.value, "/tmp/Work folder")
        XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "prompt" })?.value, "Fix this? & wait")
        XCTAssertEqual(model.lastAgentProvider, .codex)
    }

    @MainActor
    func testPendingHandoffAlreadyOpenedLocallyRetriesReportWithoutOpeningAgain() async {
        let item = attention()
        let effect = handoffEffect()
        let state = snapshot(attention: [item], effects: [effect])
        let tool = ActionTool(requested: state, invoked: state, reported: snapshot(attention: [item]))
        let defaults = UserDefaults(suiteName: "PendingHandoffReport-\(UUID().uuidString)")!
        defaults.set(["effect-handoff"], forKey: "deliveredOutsideEffects")
        let workspace = RecordingWorkspace()
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(), notifications: RecordingNotifications(),
            workspace: workspace, initialSnapshot: state
        )
        await model.handoff(attentionID: "attention-one", provider: .codex)
        XCTAssertEqual(workspace.urls.count, 0)
        let reports = await tool.reportedEffects()
        XCTAssertEqual(reports, ["effect-handoff"])
    }

    @MainActor
    func testReportedHandoffEffectOpensAgainOnAnExplicitClick() async {
        let item = attention()
        var effect = handoffEffect()
        effect["outcome"] = "opened"
        let state = snapshot(attention: [item], effects: [effect])
        let workspace = RecordingWorkspace()
        let model = AppModel(
            client: ActionTool(requested: state, invoked: state, reported: snapshot(attention: [item])),
            defaults: UserDefaults(suiteName: "ReportedHandoff-\(UUID().uuidString)")!, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: workspace, initialSnapshot: state
        )
        await model.handoff(attentionID: "attention-one", provider: .codex)
        XCTAssertEqual(workspace.urls.count, 1)
    }

    @MainActor
    func testLegacyHandoffWithoutAttentionIDIsIgnoredForMatching() async {
        let item = attention()
        var legacy = handoffEffect()
        legacy.removeValue(forKey: "attentionId")
        let initial = snapshot(attention: [item], effects: [legacy])
        let tool = ActionTool(
            requested: snapshot(attention: [item], pending: [pendingHandoff()], effects: [legacy]),
            invoked: snapshot(attention: [item], effects: [handoffEffect()]), reported: snapshot(attention: [item])
        )
        let workspace = RecordingWorkspace()
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "LegacyHandoff-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: RecordingNotifications(), workspace: workspace,
            initialSnapshot: initial
        )
        await model.handoff(attentionID: "attention-one", provider: .codex)
        XCTAssertEqual(workspace.urls.count, 1)
    }

    @MainActor
    func testConcurrentIdenticalHandoffClicksCoalesceIntoOneLaunch() async {
        let item = attention()
        let tool = ActionTool(
            requested: snapshot(attention: [item], pending: [pendingHandoff(provider: "claude")]),
            invoked: snapshot(attention: [item], effects: [handoffEffect(provider: "claude")]), reported: snapshot(attention: [item])
        )
        let workspace = RecordingWorkspace()
        let defaults = UserDefaults(suiteName: "ConcurrentHandoff-\(UUID().uuidString)")!
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: workspace, initialSnapshot: snapshot(attention: [item])
        )
        async let first: Void = model.handoff(attentionID: "attention-one", provider: .claude)
        async let second: Void = model.handoff(attentionID: "attention-one", provider: .claude)
        _ = await (first, second)
        XCTAssertEqual(workspace.urls.count, 1)
        XCTAssertEqual(defaults.string(forKey: "lastAgentProvider"), "claude")
        let reopened = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: RecordingWorkspace()
        )
        XCTAssertEqual(reopened.lastAgentProvider, .claude)
    }

    @MainActor
    func testNotificationDenialStaysAnAppFaultAndDoesNotWriteToolState() async {
        let tool = ActionTool(requested: snapshot(), invoked: snapshot(), reported: snapshot())
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "DeniedNotice-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: DeniedNotifications(), workspace: RecordingWorkspace()
        )
        await model.setNotificationsEnabled(true)
        XCTAssertFalse(model.notificationsEnabled)
        XCTAssertNotNil(model.lastError)
        let reports = await tool.reportedEffects()
        XCTAssertEqual(reports, [])
    }

    @MainActor
    func testSourceMuteIsDerivedForChildSkillAttention() {
        var child = attention()
        child["subjectId"] = "source-one:skills/one"
        let state = snapshot(
            attention: [child],
            sources: [["id": "source-one", "checkout": "/tmp/source", "branch": "main", "skillCount": 1, "attentionCount": 1, "state": "attention", "automaticUpdates": false, "nextAction": "review-attention"]],
            userSkills: [["id": "source-one:skills/one", "name": "one", "sourceId": "source-one", "sourceCheckout": "/tmp/source", "selectedPath": "skills/one", "enabled": true, "status": "attention", "branch": "main", "commit": "a"]]
        )
        let model = AppModel(
            client: ActionTool(requested: state, invoked: state, reported: state),
            defaults: UserDefaults(suiteName: "ChildMuteModel-\(UUID().uuidString)")!, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: RecordingWorkspace(), initialSnapshot: state
        )
        model.muteSource("source-one")
        XCTAssertTrue(model.isMuted(state.attention[0]))
    }

    @MainActor
    func testHandoffRequiresExactGitFactsForTheAttentionSelection() {
        var item = attention()
        item["subjectId"] = "source-one:skills/one"
        let source: [String: Any] = [
            "id": "source-one", "checkout": "/tmp/source", "branch": "main", "skillCount": 1,
            "attentionCount": 1, "state": "attention", "automaticUpdates": false, "nextAction": "review-attention",
        ]
        let exactSkill: [String: Any] = [
            "id": "source-one:skills/one", "name": "one", "sourceId": "source-one", "sourceCheckout": "/tmp/source",
            "selectedPath": "skills/one", "enabled": true, "status": "attention", "branch": "main",
            "commit": String(repeating: "a", count: 40),
        ]
        let exact = snapshot(attention: [item], sources: [source], userSkills: [exactSkill])
        let model = AppModel(
            client: ActionTool(requested: exact, invoked: exact, reported: exact),
            defaults: UserDefaults(suiteName: "HandoffFacts-\(UUID().uuidString)")!, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: RecordingWorkspace(), initialSnapshot: exact
        )
        XCTAssertTrue(model.canHandoff(exact.attention[0]))

        var incompleteSkill = exactSkill
        incompleteSkill["commit"] = NSNull()
        let incomplete = snapshot(attention: [item], sources: [source], userSkills: [incompleteSkill])
        let incompleteModel = AppModel(
            client: ActionTool(requested: incomplete, invoked: incomplete, reported: incomplete),
            defaults: UserDefaults(suiteName: "HandoffFactsMissing-\(UUID().uuidString)")!, loginItem: TestLoginItem(),
            notifications: RecordingNotifications(), workspace: RecordingWorkspace(), initialSnapshot: incomplete
        )
        XCTAssertFalse(incompleteModel.canHandoff(incomplete.attention[0]))
    }

    @MainActor
    func testResolvedNoticeUsesRecentAttentionAfterProofClosedTheItem() async {
        var resolved = attention()
        resolved["state"] = "resolved"
        let state = snapshot(
            effects: [["id": "effect-resolved", "kind": "notification", "subjectId": "source-one", "outcome": NSNull(), "attentionId": "attention-one", "reason": "opened"]],
            recentAttention: [resolved]
        )
        let tool = ActionTool(requested: state, invoked: state, reported: snapshot())
        let delivery = RecordingNotifications()
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "ResolvedNotice-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: delivery, workspace: RecordingWorkspace(), initialSnapshot: state
        )
        await model.setNotificationsEnabled(true)
        await delivery.waitForDeliveryCount(1)
        await tool.waitForReportCount(1)
        let count = await delivery.deliveries()
        XCTAssertEqual(count, 1)
        let reports = await tool.reportedEffects()
        XCTAssertEqual(reports, ["effect-resolved"])
    }

    @MainActor
    func testSuspendedDeliveryDrainsASecondSnapshotEffectWithoutLosingIt() async {
        let firstItem = attention(id: "attention-one")
        let secondItem = attention(id: "attention-two")
        let first = notificationEffect(id: "effect-one", attentionID: "attention-one")
        let second = notificationEffect(id: "effect-two", attentionID: "attention-two")
        let firstState = snapshot(attention: [firstItem, secondItem], effects: [first])
        let bothState = snapshot(attention: [firstItem, secondItem], effects: [first, second])
        let secondState = snapshot(attention: [firstItem, secondItem], effects: [second])
        let empty = snapshot(attention: [firstItem, secondItem])
        let tool = DrainRaceTool(invokeResult: bothState, reportResults: ["effect-one": secondState, "effect-two": empty])
        let delivery = SuspendingNotifications()
        let defaults = UserDefaults(suiteName: "DrainRace-\(UUID().uuidString)")!
        defaults.set(true, forKey: "notificationsEnabled")
        let model = AppModel(
            client: tool, defaults: defaults, loginItem: TestLoginItem(), notifications: delivery,
            workspace: RecordingWorkspace(), initialSnapshot: firstState
        )
        await model.setNotificationsEnabled(true)
        await delivery.waitUntilFirstDeliveryStarts()
        await model.invoke(actionID: "unrelated-action")
        await delivery.resumeFirstDelivery()
        await delivery.waitForDeliveryCount(2)
        await tool.waitForReportCount(2)
        let reports = await tool.reportedEffects()
        XCTAssertEqual(reports, ["effect-one", "effect-two"])
    }

    @MainActor
    func testReportedNotificationIsNotSelectedAgain() async {
        let item = attention()
        var reportedEffect = notificationEffect()
        reportedEffect["outcome"] = "delivered"
        let reported = snapshot(attention: [item], effects: [reportedEffect])
        let pending = snapshot(attention: [item], effects: [notificationEffect()])
        let tool = ActionTool(requested: pending, invoked: pending, reported: reported)
        let delivery = RecordingNotifications()
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "ReportedNotice-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: delivery, workspace: RecordingWorkspace(), initialSnapshot: pending
        )
        await model.setNotificationsEnabled(true)
        await tool.waitForReportCount(1)
        for _ in 0..<10 { await Task.yield() }
        let reports = await tool.reportedEffects()
        let deliveries = await delivery.deliveries()
        XCTAssertEqual(reports, ["effect-one"])
        XCTAssertEqual(deliveries, 1)
    }

    @MainActor
    func testLatestNotificationToggleWinsAcrossSlowPermission() async {
        let delivery = PermissionSuspendingNotifications()
        let model = AppModel(
            client: ActionTool(requested: snapshot(), invoked: snapshot(), reported: snapshot()),
            defaults: UserDefaults(suiteName: "ToggleRace-\(UUID().uuidString)")!, loginItem: TestLoginItem(),
            notifications: delivery, workspace: RecordingWorkspace()
        )
        let enabling = Task { @MainActor in await model.setNotificationsEnabled(true) }
        await delivery.waitUntilPermissionStarts()
        await model.setNotificationsEnabled(false)
        await delivery.resumePermission(allowed: true)
        await enabling.value
        XCTAssertFalse(model.notificationsEnabled)
    }

    @MainActor
    func testDisablingStopsDrainAndReenableResumesUndeliveredEffects() async {
        let firstItem = attention(id: "attention-one")
        let secondItem = attention(id: "attention-two")
        let first = notificationEffect(id: "effect-one", attentionID: "attention-one")
        let second = notificationEffect(id: "effect-two", attentionID: "attention-two")
        let both = snapshot(attention: [firstItem, secondItem], effects: [first, second])
        let afterFirst = snapshot(attention: [firstItem, secondItem], effects: [second])
        let empty = snapshot(attention: [firstItem, secondItem])
        let tool = DrainRaceTool(invokeResult: both, reportResults: ["effect-one": afterFirst, "effect-two": empty])
        let delivery = SuspendingNotifications()
        let model = AppModel(
            client: tool, defaults: UserDefaults(suiteName: "DisableDrain-\(UUID().uuidString)")!,
            loginItem: TestLoginItem(), notifications: delivery, workspace: RecordingWorkspace(), initialSnapshot: both
        )
        await model.setNotificationsEnabled(true)
        await delivery.waitUntilFirstDeliveryStarts()
        await model.setNotificationsEnabled(false)
        await delivery.resumeFirstDelivery()
        for _ in 0..<10 { await Task.yield() }
        let stoppedReports = await tool.reportedEffects()
        XCTAssertEqual(stoppedReports, [])
        await model.setNotificationsEnabled(true)
        await delivery.waitForDeliveryCount(2)
        await tool.waitForReportCount(2)
        let resumedReports = await tool.reportedEffects()
        XCTAssertEqual(resumedReports, ["effect-one", "effect-two"])
    }

    private func snapshot(
        attention: [[String: Any]] = [], pending: [[String: Any]] = [], effects: [[String: Any]] = [],
        sources: [[String: Any]] = [], userSkills: [[String: Any]] = [], activity: [[String: Any]] = [],
        recentAttention: [[String: Any]] = []
    ) -> AppSnapshot {
        let value: [String: Any] = [
            "version": 2, "state": "ready", "revision": 1, "freshness": ["checkedAt": "2026-08-03T14:00:00Z"],
            "summary": ["selections": 0, "current": 0, "ready": 0, "attention": attention.count],
            "sources": sources, "userSkills": userSkills, "projectSkills": [], "readyWork": [], "authorizations": [],
            "attention": attention, "recentAttention": recentAttention, "activity": activity, "pendingActions": pending,
            "outsideEffects": effects, "pause": ["active": false, "reason": NSNull(), "safetyTriggered": false],
            "watchSet": [],
        ]
        return try! JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func attention(id: String = "attention-one") -> [String: Any] { [
        "id": id, "subjectId": "source-one", "code": "selected-path-dirty", "priority": "high",
        "state": "open", "stableKey": "source-one\u{0}dirty\u{0}\(id)", "condition": "same", "observations": 1,
        "createdAt": "2026-08-03T14:00:00Z", "updatedAt": "2026-08-03T14:00:00Z",
    ] }
    private func notificationEffect(id: String = "effect-one", attentionID: String = "attention-one") -> [String: Any] { [
        "id": id, "kind": "notification", "subjectId": "source-one", "outcome": NSNull(),
        "attentionId": attentionID, "reason": "opened",
    ] }
    private func pendingHandoff(provider: String = "codex") -> [String: Any] { [
        "id": "action-one", "status": "pending", "intent": ["type": "agent-handoff", "attentionId": "attention-one", "provider": provider],
    ] }
    private func handoffEffect(provider: String = "codex") -> [String: Any] { [
        "id": "effect-handoff", "kind": "agent-handoff", "subjectId": "source-one", "outcome": NSNull(),
        "attentionId": "attention-one", "provider": provider, "workFolder": "/tmp/Work folder", "prompt": "Fix this? & wait",
    ] }
}

private actor ActionTool: ToolCalling {
    let requested: AppSnapshot
    let invoked: AppSnapshot
    let reported: AppSnapshot
    var effects: [String] = []
    var effectWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    init(requested: AppSnapshot, invoked: AppSnapshot, reported: AppSnapshot) {
        self.requested = requested; self.invoked = invoked; self.reported = reported
    }
    func status() async throws -> AppSnapshot { reported }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { reported }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { requested }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { invoked }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot {
        effects.append(effectID)
        let ready = effectWaiters.filter { effects.count >= $0.0 }
        effectWaiters.removeAll { effects.count >= $0.0 }
        ready.forEach { $0.1.resume() }
        return reported
    }
    func reportedEffects() -> [String] { effects }
    func waitForReportCount(_ target: Int) async {
        if effects.count >= target { return }
        await withCheckedContinuation { effectWaiters.append((target, $0)) }
    }
}

private actor RecordingNotifications: NotificationDelivering {
    var count = 0
    var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func requestPermission() async throws -> Bool { true }
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws {
        count += 1
        let ready = waiters.filter { count >= $0.0 }
        waiters.removeAll { count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }
    func deliveries() -> Int { count }
    func waitForDeliveryCount(_ target: Int) async {
        if count >= target { return }
        await withCheckedContinuation { waiters.append((target, $0)) }
    }
}

private actor SuspendingNotifications: NotificationDelivering {
    private var count = 0
    private var firstContinuation: CheckedContinuation<Void, Never>?
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var countWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    func requestPermission() async throws -> Bool { true }
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws {
        count += 1
        startedWaiters.forEach { $0.resume() }
        startedWaiters = []
        let ready = countWaiters.filter { count >= $0.0 }
        countWaiters.removeAll { count >= $0.0 }
        ready.forEach { $0.1.resume() }
        if count == 1 { await withCheckedContinuation { firstContinuation = $0 } }
    }
    func waitUntilFirstDeliveryStarts() async {
        if count > 0 { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }
    func resumeFirstDelivery() { firstContinuation?.resume(); firstContinuation = nil }
    func waitForDeliveryCount(_ target: Int) async {
        if count >= target { return }
        await withCheckedContinuation { countWaiters.append((target, $0)) }
    }
}

private actor PermissionSuspendingNotifications: NotificationDelivering {
    private var permissionContinuation: CheckedContinuation<Bool, Never>?
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    func requestPermission() async throws -> Bool {
        startedWaiters.forEach { $0.resume() }
        startedWaiters = []
        return await withCheckedContinuation { permissionContinuation = $0 }
    }
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws {}
    func waitUntilPermissionStarts() async {
        if permissionContinuation != nil { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }
    func resumePermission(allowed: Bool) {
        permissionContinuation?.resume(returning: allowed)
        permissionContinuation = nil
    }
}

private actor DrainRaceTool: ToolCalling {
    let invokeResult: AppSnapshot
    var reportResults: [String: AppSnapshot]
    var reports: [String] = []
    var reportWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    init(invokeResult: AppSnapshot, reportResults: [String: AppSnapshot]) {
        self.invokeResult = invokeResult; self.reportResults = reportResults
    }
    func status() async throws -> AppSnapshot { invokeResult }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { invokeResult }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { invokeResult }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { invokeResult }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot {
        reports.append(effectID)
        let ready = reportWaiters.filter { reports.count >= $0.0 }
        reportWaiters.removeAll { reports.count >= $0.0 }
        ready.forEach { $0.1.resume() }
        return reportResults[effectID] ?? .empty
    }
    func reportedEffects() -> [String] { reports }
    func waitForReportCount(_ target: Int) async {
        if reports.count >= target { return }
        await withCheckedContinuation { reportWaiters.append((target, $0)) }
    }
}

private struct DeniedNotifications: NotificationDelivering {
    func requestPermission() async throws -> Bool { false }
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws {}
}

@MainActor private final class RecordingWorkspace: WorkspaceOpening {
    var urls: [URL] = []
    func open(_ url: URL) -> Bool { urls.append(url); return true }
}

@MainActor private struct TestLoginItem: LoginItemManaging {
    var status: SMAppService.Status { .notRegistered }
    func setEnabled(_ enabled: Bool) throws {}
    func openSystemSettings() {}
}
