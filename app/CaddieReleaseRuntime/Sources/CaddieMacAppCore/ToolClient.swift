import CaddieReleaseRuntime
import Foundation

public protocol ToolCalling: Sendable {
    func status() async throws -> AppSnapshot
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot
    func requestResume() async throws -> AppSnapshot
}

public actor ToolLaunchClient: ToolCalling {
    private let supportRoot: URL
    private let environment: [String: String]
    private let resolver: any ToolLaunchResolving
    private let runner: any ToolProcessRunning
    private let retryDelay: @Sendable () async throws -> Void

    public init(
        supportRoot: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Caddie", isDirectory: true),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.supportRoot = supportRoot
        self.environment = environment
        self.resolver = ReleaseToolLaunchResolver(supportRoot: supportRoot)
        self.runner = BoundedToolProcessRunner()
        self.retryDelay = { try await Task.sleep(for: .seconds(10)) }
    }

    init(
        supportRoot: URL,
        environment: [String: String],
        resolver: any ToolLaunchResolving,
        runner: any ToolProcessRunning,
        retryDelay: @escaping @Sendable () async throws -> Void
    ) {
        self.supportRoot = supportRoot
        self.environment = environment
        self.resolver = resolver
        self.runner = runner
        self.retryDelay = retryDelay
    }

    public func status() async throws -> AppSnapshot {
        try await execute(operation: "status", input: [:])
    }

    public func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot {
        var hint: [String: JSONValue] = [
            "kind": .string(cycle.reason),
            "allObservedSources": .bool(cycle.allObservedSources),
            "refreshProjects": .bool(cycle.refreshProjects),
        ]
        if !cycle.subjectIDs.isEmpty { hint["watchIds"] = .array(cycle.subjectIDs.map(JSONValue.string)) }
        return try await execute(operation: "cycle", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "mode": .string(cycle.mode.rawValue),
            "hint": .object(hint),
            "subjectIds": .array(cycle.subjectIDs.map(JSONValue.string)),
            "refreshProjects": .bool(cycle.refreshProjects),
        ])
    }

    public func requestResume() async throws -> AppSnapshot {
        let requested = try await execute(operation: "act", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "form": .string("request"),
            "intent": .object(["type": .string("resume-reconciliation")]),
        ])
        guard let action = requested.pendingActions.first(where: {
            $0.status == "pending" && $0.intent.type == "resume-reconciliation"
        }) else {
            if !requested.pause.active { return requested }
            throw ToolClientFault.invalidResponse
        }
        return try await execute(operation: "act", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "form": .string("invoke"),
            "actionId": .string(action.id),
            "approval": .string("explicit"),
        ], timeoutOverride: 120)
    }

    private func execute(
        operation: String,
        input: [String: JSONValue],
        timeoutOverride: TimeInterval? = nil
    ) async throws -> AppSnapshot {
        let request = ToolRequest(
            version: 2, requestId: UUID().uuidString.lowercased(), caller: "app", operation: operation, input: input
        )
        let requestData = try JSONEncoder().encode(request)
        var env = environment
        env["CADDIE_TOOL_LAUNCH_RECORD"] = supportRoot.appendingPathComponent(CaddieReleaseRuntime.launchRecordName).path
        let timeout: TimeInterval = timeoutOverride ?? (operation == "cycle" ? 120 : 5)
        let output: Data
        do {
            output = try await runner.run(
                launch: try await resolver.resolve(), environment: env, request: requestData, timeout: timeout
            )
        } catch ToolProcessFault.timeout {
            try await retryDelay()
            output = try await runner.run(
                launch: try await resolver.resolve(), environment: env, request: requestData, timeout: timeout
            )
        }
        let response = try ToolResponse.validated(output, requestId: request.requestId, operation: operation)
        if let snapshot = response.result?.snapshot, response.ok { return snapshot }
        throw response.error ?? ToolClientFault.invalidResponse
    }

}

struct ToolLaunchDescription: Equatable, Sendable {
    let executable: URL
    let arguments: [String]
}

protocol ToolLaunchResolving: Sendable { func resolve() async throws -> ToolLaunchDescription }

struct ReleaseToolLaunchResolver: ToolLaunchResolving {
    let supportRoot: URL

    func resolve() async throws -> ToolLaunchDescription {
        let record = try await CaddieReleaseRuntime(supportRoot: supportRoot).checkedLaunchRecord()
        let launcher = Self.launcherURL(forSkillArtifact: URL(fileURLWithPath: record.active.skill.path))
        guard FileManager.default.fileExists(atPath: launcher.path) else { throw ToolClientFault.missingLauncher }
        return .init(executable: URL(fileURLWithPath: record.active.node.path), arguments: [launcher.path])
    }

    static func launcherURL(forSkillArtifact skill: URL) -> URL {
        skill.appendingPathComponent("tool/launch.mjs")
    }
}

private struct ToolRequest: Encodable {
    let version: Int
    let requestId: String
    let caller: String
    let operation: String
    let input: [String: JSONValue]
}

public enum JSONValue: Encodable, Sendable {
    case string(String)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .string(item): try value.encode(item)
        case let .bool(item): try value.encode(item)
        case let .array(item): try value.encode(item)
        case let .object(item): try value.encode(item)
        }
    }
}

public enum ToolClientFault: Error, Equatable {
    case invalidResponse
    case missingLauncher
    case processFailed(String)
}
