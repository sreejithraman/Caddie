import XCTest
@testable import CaddieMacAppCore

final class WatchSwapTests: XCTestCase {
    func testToolStateWritesCanRefreshWithoutStartingAnotherCycle() {
        let observation = FileObservation(
            watchIDs: ["user-state"],
            changedPaths: [
                "/Users/example/.agents/.caddie/management-v2.json.lock",
                "/Users/example/.agents/.caddie/management-v2.json.lock.release-value",
                "/Users/example/.agents/.caddie/.management-v2.json.42.value.tmp",
                "/Users/example/.agents/.caddie/management-v2.json",
                "/Users/example/.agents/.caddie",
            ],
            toolStateRoot: "/Users/example/.agents/.caddie",
            rootsUncertain: false
        )

        XCTAssertTrue(observation.containsOnlyToolStateChanges)
    }

    func testARealStateRootChangeStillStartsAFullCycle() {
        let observation = FileObservation(
            watchIDs: ["user-state"],
            changedPaths: [
                "/Users/example/.agents/.caddie/management-v2.json",
                "/Users/example/.agents/.caddie/manifest.json",
            ],
            toolStateRoot: "/Users/example/.agents/.caddie",
            rootsUncertain: false
        )

        XCTAssertFalse(observation.containsOnlyToolStateChanges)
    }

    func testAChangedWatchRootNeverLooksLikeAToolStateWrite() {
        let observation = FileObservation(
            watchIDs: ["user-state"],
            changedPaths: ["/Users/example/.agents/.caddie"],
            toolStateRoot: "/Users/example/.agents/.caddie",
            rootsUncertain: false
        )

        XCTAssertFalse(observation.containsOnlyToolStateChanges)
    }

    func testSameNamedFileInASkillSourceStillStartsAFullCycle() {
        let observation = FileObservation(
            watchIDs: ["source"],
            changedPaths: ["/Users/example/Source/management-v2.json"],
            toolStateRoot: "/Users/example/.agents/.caddie",
            rootsUncertain: false
        )

        XCTAssertFalse(observation.containsOnlyToolStateChanges)
    }

    func testFailedReplacementKeepsPriorLiveStream() {
        let swap = LiveWatchSwap<String>()
        XCTAssertTrue(swap.replace(start: { "old" }, stop: { _ in XCTFail("nothing to stop") }))
        var stopped: [String] = []

        XCTAssertFalse(swap.replace(start: { nil }, stop: { stopped.append($0) }))

        XCTAssertEqual(swap.current, "old")
        XCTAssertEqual(stopped, [])
    }

    func testReplacementStartsBeforeStoppingPriorStream() {
        let swap = LiveWatchSwap<String>()
        var events: [String] = []
        XCTAssertTrue(swap.replace(start: { events.append("start-old"); return "old" }, stop: { _ in }))

        XCTAssertTrue(swap.replace(
            start: { events.append("start-new"); return "new" },
            stop: { events.append("stop-\($0)") }
        ))

        XCTAssertEqual(events, ["start-old", "start-new", "stop-old"])
        XCTAssertEqual(swap.current, "new")
    }
}
