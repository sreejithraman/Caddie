import CaddieReleaseRuntime
import Foundation

public protocol ToolCalling: Sendable {
    func status() async throws -> AppSnapshot
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot
    func requestResume() async throws -> AppSnapshot
}

public extension ToolCalling {
    func requestResume() async throws -> AppSnapshot {
        let requested = try await request(.resumeReconciliation)
        guard let action = requested.pendingActions.first(where: {
            $0.status == "pending" && $0.intent.type == "resume-reconciliation"
        }) else {
            if !requested.pause.active { return requested }
            throw ToolClientFault.invalidResponse
        }
        return try await invoke(actionID: action.id, extendedTimeout: true)
    }
}

public enum AppActionIntent: Equatable, Sendable {
    case authorize(selectionID: String)
    case revokeAuthorization(selectionID: String)
    case update(selectionID: String)
    case retry(attentionID: String)
    case handoff(attentionID: String, provider: AgentProvider)
    case resumeReconciliation

    var fields: [String: JSONValue] {
        switch self {
        case let .authorize(id): return ["type": .string("authorize-reconciliation"), "selectionId": .string(id)]
        case let .revokeAuthorization(id): return ["type": .string("revoke-reconciliation"), "selectionId": .string(id)]
        case let .update(id): return ["type": .string("update-selection"), "selectionId": .string(id)]
        case let .retry(id): return ["type": .string("retry"), "attentionId": .string(id)]
        case let .handoff(id, provider): return ["type": .string("agent-handoff"), "attentionId": .string(id), "provider": .string(provider.rawValue)]
        case .resumeReconciliation: return ["type": .string("resume-reconciliation")]
        }
    }

    var type: String {
        if case let .string(value) = fields["type"] { return value }
        preconditionFailure("Every app intent has a type")
    }

    var completesOnRequest: Bool {
        if case .revokeAuthorization = self { return true }
        return false
    }

    func matches(_ stored: AppSnapshot.PendingAction.Intent) -> Bool {
        guard stored.type == type else { return false }
        switch self {
        case let .authorize(id), let .revokeAuthorization(id), let .update(id):
            return stored.selectionId == id
        case let .retry(id): return stored.attentionId == id
        case let .handoff(id, provider): return stored.attentionId == id && stored.provider == provider.rawValue
        case .resumeReconciliation: return true
        }
    }
}

public enum AgentProvider: String, CaseIterable, Sendable { case codex, claude }
public extension AgentProvider { var displayName: String { self == .codex ? "Codex" : "Claude" } }
public enum AppEffectOutcome: String, Sendable { case delivered, failed, unavailable, opened }

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

    public func request(_ intent: AppActionIntent) async throws -> AppSnapshot {
        try await execute(operation: "act", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "form": .string("request"),
            "intent": .object(intent.fields),
        ])
    }

    public func invoke(actionID: String, extendedTimeout: Bool = false) async throws -> AppSnapshot {
        try await execute(operation: "act", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "form": .string("invoke"),
            "actionId": .string(actionID),
            "approval": .string("explicit"),
        ], timeoutOverride: extendedTimeout ? 120 : nil)
    }

    public func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot {
        try await execute(operation: "act", input: [
            "idempotencyId": .string(UUID().uuidString.lowercased()),
            "form": .string("report-effect"),
            "effectId": .string(effectID),
            "outcome": .string(outcome.rawValue),
        ])
    }

    private func execute(
        operation: String,
        input: [String: JSONValue],
        timeoutOverride: TimeInterval? = nil
    ) async throws -> AppSnapshot {
        let snapshot = try await executeOnce(operation: operation, input: input, timeoutOverride: timeoutOverride)
        return try await completePages(in: snapshot)
    }

    private func executeOnce(
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

    private func completePages(in first: AppSnapshot) async throws -> AppSnapshot {
        let supported = Set([
            "sources", "userSkills", "projectSkills", "skillInventory", "projects", "readyWork", "authorizations",
            "attention", "recentAttention", "activity", "pendingActions", "outsideEffects", "watchSet",
        ])
        let fields = first.continuations?.map(\.field).reduce(into: [String]()) { result, field in
            if !result.contains(field) { result.append(field) }
        } ?? []
        guard fields.allSatisfy(supported.contains) else { throw ToolClientFault.invalidResponse }
        var pages: [String: [AppSnapshot]] = [:]
        var seen = Set<String>()
        for field in fields {
            var continuation = first.continuations?.first { $0.field == field }
            var fieldPageCount = 0
            while let current = continuation {
                fieldPageCount += 1
                guard seen.insert(current.token).inserted, fieldPageCount <= 100 else {
                    throw ToolClientFault.invalidResponse
                }
                let page = try await executeOnce(
                    operation: "status", input: ["continuationToken": .string(current.token)]
                )
                if field == "skillInventory", page.skillInventory == nil { throw ToolClientFault.invalidResponse }
                if field == "projects", page.projects == nil { throw ToolClientFault.invalidResponse }
                pages[field, default: []].append(page)
                continuation = page.continuations?.first { $0.field == field }
            }
        }
        return first.completingPages(pages)
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
