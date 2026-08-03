import Foundation
import XCTest
@testable import CaddieMacAppCore

final class ToolClientTests: XCTestCase {
    func testRunnerObservesFastExitWithoutHanging() async throws {
        let output = try await BoundedToolProcessRunner(stopGrace: 0.01).run(
            launch: .init(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "printf fast"]),
            environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 1
        )
        XCTAssertEqual(String(decoding: output, as: UTF8.self), "fast")
    }

    func testRunnerStopsTimedOutProcess() async {
        await XCTAssertThrowsErrorAsync {
            _ = try await BoundedToolProcessRunner(stopGrace: 0.01).run(
                launch: .init(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "while :; do :; done"]),
                environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 0.02
            )
        } verify: { XCTAssertEqual($0 as? ToolProcessFault, .timeout) }
    }

    func testRunnerHardStopsATermIgnoringProcess() async {
        let started = Date()
        await XCTAssertThrowsErrorAsync {
            _ = try await BoundedToolProcessRunner(maximumStdout: 32, stopGrace: 0.03).run(
                launch: .init(
                    executable: URL(fileURLWithPath: "/bin/sh"),
                    arguments: ["-c", "trap '' TERM; while :; do printf x; done"]
                ),
                environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 1
            )
        } verify: { XCTAssertEqual($0 as? ToolProcessFault, .stdoutOverflow) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testRunnerStopsOversizedOutput() async {
        await XCTAssertThrowsErrorAsync {
            _ = try await BoundedToolProcessRunner(maximumStdout: 32, stopGrace: 0.01).run(
                launch: .init(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "printf '%080d' 0"]),
                environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 1
            )
        } verify: { XCTAssertEqual($0 as? ToolProcessFault, .stdoutOverflow) }
    }

    func testClientRetriesOneTimeoutAndDecodesSnapshot() async throws {
        let runner = ScriptedRunner(results: [.failure(ToolProcessFault.timeout), .success(Self.uninitializedResponse)])
        let resolver = RecordingResolver()
        let client = ToolLaunchClient(
            supportRoot: URL(fileURLWithPath: "/tmp/caddie-test"), environment: [:],
            resolver: resolver, runner: runner, retryDelay: {}
        )
        let snapshot = try await client.status()
        let calls = await runner.count()
        let resolutions = await resolver.count()
        let requests = await runner.requests()
        XCTAssertEqual(snapshot, .empty)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(resolutions, 2)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0], requests[1])
    }

    func testClientRejectsMalformedToolOutput() async {
        let runner = ScriptedRunner(results: [.success(Data("{".utf8))])
        let client = ToolLaunchClient(
            supportRoot: URL(fileURLWithPath: "/tmp/caddie-test"), environment: [:],
            resolver: FixedResolver(), runner: runner, retryDelay: {}
        )
        await XCTAssertThrowsErrorAsync { _ = try await client.status() } verify: {
            XCTAssertEqual($0 as? ToolClientFault, .invalidResponse)
        }
    }

    func testSafetyResumeRequestsThenInvokesOneExactApprovedAction() async throws {
        let runner = ScriptedRunner(results: [
            .success(Self.response(safetyPaused: true, pendingResume: true)),
            .success(Self.response(safetyPaused: false, pendingResume: false)),
        ])
        let client = ToolLaunchClient(
            supportRoot: URL(fileURLWithPath: "/tmp/caddie-test"), environment: [:],
            resolver: FixedResolver(), runner: runner, retryDelay: {}
        )

        let resumed = try await client.requestResume()
        let requests = try await runner.requests().map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any])
        }
        let timeouts = await runner.timeouts()
        let secondInput = try XCTUnwrap(requests[1]["input"] as? [String: Any])

        XCTAssertFalse(resumed.pause.active)
        XCTAssertEqual(timeouts, [5, 120])
        XCTAssertEqual(secondInput["form"] as? String, "invoke")
        XCTAssertEqual(secondInput["actionId"] as? String, "resume-action")
        XCTAssertEqual(secondInput["approval"] as? String, "explicit")
    }

    func testClientRejectsExtraAndConflictingEnvelopeBranches() async {
        for malformed in [
            #"{"version":2,"ok":true,"requestId":"fixture","operation":"status","result":{"snapshot":{}},"error":{"code":"x","message":"x","disposition":"bug"}}"#,
            #"{"version":2,"ok":true,"requestId":"fixture","operation":"status","result":{"snapshot":{},"extra":true}}"#,
            #"{"version":2,"ok":false,"requestId":"fixture","operation":"status","error":{"code":"x","message":"x","disposition":"bug","extra":true}}"#,
        ] {
            let runner = ScriptedRunner(results: [.success(Data(malformed.utf8))])
            let client = ToolLaunchClient(
                supportRoot: URL(fileURLWithPath: "/tmp/caddie-test"), environment: [:],
                resolver: FixedResolver(), runner: runner, retryDelay: {}
            )
            await XCTAssertThrowsErrorAsync { _ = try await client.status() } verify: {
                XCTAssertEqual($0 as? ToolClientFault, .invalidResponse)
            }
        }
    }

    func testCurrentToolStatusResponseDecodesAsAppSnapshot() async throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let tool = repository.appendingPathComponent("skills/caddie/tool/caddie.mjs")
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("caddie-app-decode-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = home.path
        let request = Data(#"{"version":2,"requestId":"app-decode","caller":"app","operation":"status","input":{}}"#.utf8)
        let output = try await BoundedToolProcessRunner().run(
            launch: .init(executable: URL(fileURLWithPath: "/usr/bin/env"), arguments: ["node", tool.path]),
            environment: environment, request: request, timeout: 5
        )
        let response = try JSONDecoder().decode(ToolResponse.self, from: output)
        XCTAssertEqual(response.result?.snapshot, .empty)
    }

    func testLauncherLivesInsideTheBoundSourceSkillArtifact() {
        let skill = URL(fileURLWithPath: "/Applications/Caddie/Releases/one/skill")
        XCTAssertEqual(
            ReleaseToolLaunchResolver.launcherURL(forSkillArtifact: skill).path,
            "/Applications/Caddie/Releases/one/skill/tool/launch.mjs"
        )
    }

    private static let uninitializedResponse = Data(#"{"version":2,"ok":true,"requestId":"fixture","operation":"status","result":{"snapshot":{"version":2,"state":"uninitialized","revision":0,"freshness":{"checkedAt":null},"compatibility":{"protocol":2,"state":2},"coverage":{"status":"unknown","issues":[]},"summary":{"selections":0,"current":0,"ready":0,"attention":0},"sources":[],"userSkills":[],"projectSkills":[],"readyWork":[],"authorizations":[],"attention":[],"recentAttention":[],"activity":[],"pendingActions":[],"outsideEffects":[],"pause":{"active":false,"reason":null,"safetyTriggered":false,"startedAt":null},"watchSet":[],"continuations":[]}}}"#.utf8)

    private static func response(safetyPaused: Bool, pendingResume: Bool) -> Data {
        var envelope = try! JSONSerialization.jsonObject(with: uninitializedResponse) as! [String: Any]
        var result = envelope["result"] as! [String: Any]
        var snapshot = result["snapshot"] as! [String: Any]
        snapshot["state"] = "ready"
        let reason: Any = safetyPaused ? "verification-failed" : NSNull()
        let startedAt: Any = safetyPaused ? "2026-08-03T14:00:00Z" : NSNull()
        snapshot["pause"] = [
            "active": safetyPaused, "reason": reason,
            "safetyTriggered": safetyPaused, "startedAt": startedAt,
        ]
        snapshot["pendingActions"] = pendingResume ? [[
            "version": 2, "id": "resume-action", "status": "pending", "subjectId": "tool",
            "intent": ["type": "resume-reconciliation"], "boundRevision": 1,
            "createdAt": "2026-08-03T14:00:00Z", "expiresAt": "2026-08-04T14:00:00Z",
            "approvalPrompt": "Resume?", "preservationRules": [], "recoveryEffect": "none",
        ]] : []
        result["snapshot"] = snapshot
        envelope["result"] = result
        return try! JSONSerialization.data(withJSONObject: envelope)
    }
}

private struct FixedResolver: ToolLaunchResolving {
    func resolve() async throws -> ToolLaunchDescription {
        .init(executable: URL(fileURLWithPath: "/usr/bin/true"), arguments: [])
    }
}

private actor RecordingResolver: ToolLaunchResolving {
    private var calls = 0
    func resolve() async throws -> ToolLaunchDescription {
        calls += 1
        return .init(executable: URL(fileURLWithPath: "/usr/bin/true"), arguments: [])
    }
    func count() -> Int { calls }
}

private actor ScriptedRunner: ToolProcessRunning {
    private var results: [Result<Data, Error>]
    private var calls = 0
    private var sentRequests: [Data] = []
    private var sentTimeouts: [TimeInterval] = []
    init(results: [Result<Data, Error>]) { self.results = results }
    func run(launch: ToolLaunchDescription, environment: [String: String], request: Data, timeout: TimeInterval) async throws -> Data {
        calls += 1
        sentRequests.append(request)
        sentTimeouts.append(timeout)
        let data = try results.removeFirst().get()
        guard var response = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sent = try? JSONSerialization.jsonObject(with: request) as? [String: Any] else { return data }
        response["requestId"] = sent["requestId"]
        response["operation"] = sent["operation"]
        return try JSONSerialization.data(withJSONObject: response)
    }
    func count() -> Int { calls }
    func requests() -> [Data] { sentRequests }
    func timeouts() -> [TimeInterval] { sentTimeouts }
}

private extension XCTestCase {
    func XCTAssertThrowsErrorAsync(
        _ expression: () async throws -> Void,
        verify: (Error) -> Void = { _ in },
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await expression()
            XCTFail("expected an error", file: file, line: line)
        } catch { verify(error) }
    }
}
