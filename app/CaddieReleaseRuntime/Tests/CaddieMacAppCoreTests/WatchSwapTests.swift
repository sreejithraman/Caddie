import XCTest
@testable import CaddieMacAppCore

final class WatchSwapTests: XCTestCase {
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
