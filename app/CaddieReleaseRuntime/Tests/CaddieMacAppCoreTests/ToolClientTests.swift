import Foundation
import XCTest
@testable import CaddieMacAppCore
import CaddieReleaseRuntime

final class ToolClientTests: XCTestCase {
    func testStagedStatusCheckRejectsIncompleteSuccessEnvelope() async {
        let runner = ScriptedRunner(results: [.success(Data(#"{"ok":true}"#.utf8))])
        let artifact = ReleaseArtifact(version: "development", path: "/tmp/tool", fingerprint: String(repeating: "a", count: 64))
        let binding = ToolReleaseBinding(
            releaseID: "development",
            releasePath: "/tmp/release",
            node: artifact,
            tool: artifact,
            skill: artifact,
            compatibility: .caddieCurrent
        )

        await XCTAssertThrowsErrorAsync {
            try await StagedToolStatusChecker(runner: runner).check(binding: binding, environment: [:])
        } verify: {
            XCTAssertEqual($0 as? ToolClientFault, .invalidResponse)
        }
    }

    func testRunnerObservesFastExitWithoutHanging() async throws {
        let output = try await BoundedToolProcessRunner(stopGrace: 0.01).run(
            launch: .init(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", "printf fast"]),
            environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 1
        )
        XCTAssertEqual(String(decoding: output, as: UTF8.self), "fast")
    }

    func testRunnerDrainsInterleavedOutputWithoutStalling() async throws {
        let started = Date()
        let output = try await BoundedToolProcessRunner(stopGrace: 0.01).run(
            launch: .init(
                executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "for index in $(seq 1 2000); do printf x; printf y >&2; done"]
            ),
            environment: ProcessInfo.processInfo.environment, request: Data(), timeout: 2
        )
        XCTAssertEqual(output, Data(repeating: Character("x").asciiValue!, count: 2_000))
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
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

    func testEveryMenuDomainActionUsesOneClosedBoundedActForm() async throws {
        let intents: [(AppActionIntent, [String: String])] = [
            (.authorize(selectionID: "selection-one"), ["type": "authorize-reconciliation", "selectionId": "selection-one"]),
            (.revokeAuthorization(selectionID: "selection-one"), ["type": "revoke-reconciliation", "selectionId": "selection-one"]),
            (.update(selectionID: "selection-one"), ["type": "update-selection", "selectionId": "selection-one"]),
            (.retry(attentionID: "attention-one"), ["type": "retry", "attentionId": "attention-one"]),
            (.handoff(attentionID: "attention-one", provider: .codex), ["type": "agent-handoff", "attentionId": "attention-one", "provider": "codex"]),
            (.handoff(attentionID: "attention-one", provider: .claude), ["type": "agent-handoff", "attentionId": "attention-one", "provider": "claude"]),
        ]
        let runner = ScriptedRunner(results: Array(repeating: .success(Self.uninitializedResponse), count: intents.count + 2))
        let client = ToolLaunchClient(
            supportRoot: URL(fileURLWithPath: "/tmp/caddie-test"), environment: [:],
            resolver: FixedResolver(), runner: runner, retryDelay: {}
        )
        for (intent, _) in intents { _ = try await client.request(intent) }
        _ = try await client.invoke(actionID: "opaque-action", extendedTimeout: false)
        _ = try await client.report(effectID: "opaque-effect", outcome: .delivered)

        let requests = try await runner.requests().map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        for (index, pair) in intents.enumerated() {
            let input = try XCTUnwrap(requests[index]["input"] as? [String: Any])
            XCTAssertEqual(input["form"] as? String, "request")
            XCTAssertNotNil(input["idempotencyId"] as? String)
            let intent = try XCTUnwrap(input["intent"] as? [String: String])
            XCTAssertEqual(intent, pair.1)
            XCTAssertEqual(Set(input.keys), ["idempotencyId", "form", "intent"])
        }
        let invoke = try XCTUnwrap(requests[intents.count]["input"] as? [String: Any])
        XCTAssertEqual(Set(invoke.keys), ["idempotencyId", "form", "actionId", "approval"])
        XCTAssertEqual(invoke["actionId"] as? String, "opaque-action")
        let report = try XCTUnwrap(requests[intents.count + 1]["input"] as? [String: Any])
        XCTAssertEqual(Set(report.keys), ["idempotencyId", "form", "effectId", "outcome"])
        XCTAssertEqual(report["effectId"] as? String, "opaque-effect")
    }

    func testActionMatchingRejectsStalePendingWorkForAnotherSubject() {
        let other = AppSnapshot.PendingAction.Intent(
            type: "update-selection", selectionId: "selection-old", attentionId: nil, provider: nil
        )
        XCTAssertFalse(AppActionIntent.update(selectionID: "selection-new").matches(other))
        let exact = AppSnapshot.PendingAction.Intent(
            type: "agent-handoff", selectionId: nil, attentionId: "attention-one", provider: "claude"
        )
        XCTAssertFalse(AppActionIntent.handoff(attentionID: "attention-one", provider: .codex).matches(exact))
        XCTAssertTrue(AppActionIntent.handoff(attentionID: "attention-one", provider: .claude).matches(exact))
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

    func testToolAgentHandoffEffectCarriesExactAttentionIntoAppSnapshot() throws {
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.uninitializedResponse) as? [String: Any])
        var result = try XCTUnwrap(envelope["result"] as? [String: Any])
        var snapshot = try XCTUnwrap(result["snapshot"] as? [String: Any])
        snapshot["attention"] = [[
            "version": 2, "id": "attention-one", "stableKey": "stable", "subjectId": "selection-one",
            "code": "blocked", "condition": "same", "priority": "high", "state": "opened-in-agent",
            "observations": 1, "createdAt": "2026-08-03T14:00:00Z", "updatedAt": "2026-08-03T14:00:00Z",
        ]]
        snapshot["outsideEffects"] = [[
            "version": 2, "id": "effect-one", "kind": "agent-handoff", "subjectId": "selection-one",
            "attentionId": "attention-one", "provider": "codex", "workFolder": "/tmp/work", "prompt": "Help",
            "outcome": NSNull(), "createdAt": "2026-08-03T14:00:00Z",
        ]]
        result["snapshot"] = snapshot
        envelope["result"] = result
        let data = try JSONSerialization.data(withJSONObject: envelope)
        let response = try ToolResponse.validated(data, requestId: "fixture", operation: "status")
        XCTAssertEqual(response.result?.snapshot.outsideEffects.first?.attentionId, "attention-one")
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
