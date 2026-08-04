import XCTest
@testable import CaddieMacAppCore

final class SchedulerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testFileBurstsWaitForTwoSecondsOfQuiet() {
        var state = CycleSchedulerState()
        XCTAssertEqual(state.receive(.filesChanged(subjectIDs: ["one"]), at: start), start.addingTimeInterval(2))
        XCTAssertEqual(state.receive(.filesChanged(subjectIDs: ["two"]), at: start.addingTimeInterval(1)), start.addingTimeInterval(3))
        XCTAssertNil(state.beginDueCycle(at: start.addingTimeInterval(2.9), automaticUpdatesPaused: false))
        let cycle = state.beginDueCycle(at: start.addingTimeInterval(3), automaticUpdatesPaused: false)
        XCTAssertEqual(cycle?.mode, .authorized)
        XCTAssertEqual(cycle?.subjectIDs, ["one", "two"])
    }

    func testFileEventAtQuietDeadlineStartsANewQuietWindow() {
        var state = CycleSchedulerState()
        state.receive(.filesChanged(subjectIDs: ["one"]), at: start)
        XCTAssertEqual(
            state.receive(.filesChanged(subjectIDs: ["one"]), at: start.addingTimeInterval(2)),
            start.addingTimeInterval(4)
        )
        XCTAssertNil(state.beginDueCycle(at: start.addingTimeInterval(2), automaticUpdatesPaused: false))
    }

    func testFileEventAfterStalledMainThreadResetsExpiredQuietDeadline() {
        var state = CycleSchedulerState()
        state.receive(.filesChanged(subjectIDs: ["one"]), at: start)
        XCTAssertEqual(
            state.receive(.filesChanged(subjectIDs: ["one"]), at: start.addingTimeInterval(3)),
            start.addingTimeInterval(5)
        )
        XCTAssertNil(state.beginDueCycle(at: start.addingTimeInterval(3), automaticUpdatesPaused: false))
    }

    func testConstantChangeForcesObserveOnlyAtThirtySeconds() {
        var state = CycleSchedulerState()
        for second in 0...29 {
            state.receive(.filesChanged(subjectIDs: ["source"]), at: start.addingTimeInterval(Double(second)))
        }
        let cycle = state.beginDueCycle(at: start.addingTimeInterval(30), automaticUpdatesPaused: false)
        XCTAssertEqual(cycle?.mode, .observeOnly)
        XCTAssertEqual(cycle?.reason, "constant-change")
    }

    func testOneRunAtATimeAndDirtyEventsRunAgain() {
        var state = CycleSchedulerState()
        state.receive(.appStart, at: start)
        XCTAssertNotNil(state.beginDueCycle(at: start, automaticUpdatesPaused: false))
        state.receive(.filesChanged(subjectIDs: ["changed-during-run"]), at: start.addingTimeInterval(1))
        XCTAssertNil(state.beginDueCycle(at: start.addingTimeInterval(3), automaticUpdatesPaused: false))
        XCTAssertEqual(state.finishCycle(), start.addingTimeInterval(3))
        XCTAssertEqual(state.beginDueCycle(at: start.addingTimeInterval(3), automaticUpdatesPaused: false)?.subjectIDs, ["changed-during-run"])
    }

    func testDroppedEventsRequestFullObserveOnlyPass() {
        var state = CycleSchedulerState()
        state.receive(.watchRootsUncertain, at: start)
        let cycle = state.beginDueCycle(at: start, automaticUpdatesPaused: false)
        XCTAssertEqual(cycle?.mode, .observeOnly)
        XCTAssertEqual(cycle?.allObservedSources, true)
        XCTAssertEqual(cycle?.refreshProjects, false)
    }

    func testOnlyStartWakeAndManualSyncRefreshProjects() {
        for event in [ObservationEvent.appStart, .wake, .syncNow] {
            var state = CycleSchedulerState()
            state.receive(event, at: start)
            XCTAssertEqual(state.beginDueCycle(at: start, automaticUpdatesPaused: false)?.refreshProjects, true)
        }
        var changed = CycleSchedulerState()
        changed.receive(.registrationChanged, at: start)
        XCTAssertEqual(changed.beginDueCycle(at: start, automaticUpdatesPaused: false)?.refreshProjects, false)
    }

    func testLocalPauseKeepsInspectionObserveOnly() {
        var state = CycleSchedulerState()
        state.receive(.syncNow, at: start)
        XCTAssertEqual(state.beginDueCycle(at: start, automaticUpdatesPaused: true)?.mode, .observeOnly)
    }

    func testToolStateHintWaitsForOneVerificationAfterAChangedCycle() {
        var state = InspectionVerificationState()
        state.finishCycle(changed: true)

        XCTAssertTrue(state.consumeToolStateHint(snapshotChanged: false))
        XCTAssertFalse(state.consumeToolStateHint(snapshotChanged: false))
    }

    func testNewerAcceptedSnapshotDoesNotErasePendingVerification() {
        var state = InspectionVerificationState()
        state.finishCycle(changed: true)

        XCTAssertTrue(state.consumeToolStateHint(snapshotChanged: true))
        XCTAssertFalse(state.pending)
    }

    func testAnInterveningCycleConsumesPriorVerification() {
        var state = InspectionVerificationState()
        state.finishCycle(changed: true)
        XCTAssertTrue(state.beginCycle())
        state.finishCycle(changed: false)

        XCTAssertFalse(state.consumeToolStateHint(snapshotChanged: false))
    }

    func testFailedStatusRefreshKeepsTheFileHintAndPendingVerification() {
        var state = InspectionVerificationState()
        state.finishCycle(changed: true)

        XCTAssertTrue(state.consumeToolStateHint(snapshotChanged: nil))
        XCTAssertTrue(state.pending)
        XCTAssertTrue(state.beginCycle())
    }
}
