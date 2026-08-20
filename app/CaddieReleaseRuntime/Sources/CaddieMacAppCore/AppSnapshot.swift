import Foundation

public struct AppSnapshot: Codable, Equatable, Sendable {
    public let version: Int
    public let state: String
    public let revision: Int
    public let freshness: Freshness
    public let summary: Summary
    public let sources: [Source]
    public let userSkills: [UserSkill]
    public let projectSkills: [ProjectSkill]
    public let skillInventory: [InventorySkill]?
    public let projects: [ProjectInventory]?
    public let readyWork: [ReadyWork]
    public let authorizations: [Authorization]
    public let attention: [Attention]
    public let recentAttention: [Attention]
    public let activity: [Activity]
    public let pendingActions: [PendingAction]
    public let outsideEffects: [OutsideEffect]
    public let pause: Pause
    public let watchSet: [Watch]
    public let recovery: Recovery?
    public let continuations: [Continuation]?

    public struct Freshness: Codable, Equatable, Sendable {
        public let checkedAt: String?
    }

    public struct Summary: Codable, Equatable, Sendable {
        public let selections: Int
        public let current: Int
        public let ready: Int
        public let attention: Int
    }

    public struct Source: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let checkout: String?
        public let branch: String?
        public let skillCount: Int
        public let attentionCount: Int
        public let state: String
        public let automaticUpdates: Bool
        public let nextAction: String
    }

    public struct UserSkill: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String?
        public let sourceId: String
        public let sourceCheckout: String?
        public let selectedPath: String
        public let enabled: Bool
        public let status: String
        public let branch: String?
        public let commit: String?
    }

    public struct ProjectSkill: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let projectRoot: String
        public let status: String
        public let name: String?
        public let sourceId: String?
        public let selectedPath: String?
        public let code: String?
    }

    public struct InventorySkill: Codable, Equatable, Identifiable, Sendable {
        public let version: Int
        public let id: String
        public let scope: String
        public let projectRoot: String?
        public let name: String
        public let installedPath: String
        public let enabled: Bool
        public let managed: Bool
        public let selectionId: String?
        public let origin: SkillOrigin?
        public let shadowsSkillId: String?
        public let status: String
        public let permissionFolder: String?
    }

    public struct SkillOrigin: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let sourceId: String
        public let name: String
        public let type: String
        public let gitUrl: String?
        public let localFolder: String?
        public let selectedPath: String

        public var location: String { gitUrl ?? localFolder ?? "Unknown source" }
    }

    public struct ProjectInventory: Codable, Equatable, Identifiable, Sendable {
        public let version: Int
        public let id: String
        public let name: String
        public let root: String
        public let projectSkillCount: Int
        public let inheritedUserSkillCount: Int
        public let overrideCount: Int
        public let status: String
        public let selectedSkillCount: Int?
        public let issueCode: String?
        public let repairAvailable: Bool?
        public let repositoryId: String?
        public let checkoutKind: String?
        public let branch: String?
        public let mainProjectRoot: String?
        public let workingTreeClean: Bool?
        public let upstreamState: String?
        public let includedInDefaultBranch: Bool?
        public let lifecycle: String?
    }

    public struct ReadyWork: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let selectionId: String
        public let kind: String
        public let authorized: Bool
    }

    public struct Attention: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let subjectId: String
        public let code: String
        public let priority: String
        public let state: String
        public let stableKey: String
        public let condition: String
        public let observations: Int
        public let createdAt: String
        public let updatedAt: String
    }

    public struct Authorization: Codable, Equatable, Identifiable, Sendable {
        public var id: String { selectionId }
        public let selectionId: String
        public let active: Bool

        private enum CodingKeys: String, CodingKey { case selectionId, active }
    }

    public struct Activity: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let subjectId: String
        public let createdAt: String
    }

    public struct PendingAction: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let status: String
        public let intent: Intent

        public struct Intent: Codable, Equatable, Sendable {
            public let type: String
            public let selectionId: String?
            public let attentionId: String?
            public let provider: String?
            public let projectRoot: String?
        }
    }

    public struct OutsideEffect: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let kind: String
        public let subjectId: String
        public let outcome: String?
        public let attentionId: String?
        public let reason: String?
        public let provider: String?
        public let workFolder: String?
        public let prompt: String?
    }

    public struct Pause: Codable, Equatable, Sendable {
        public let active: Bool
        public let reason: String?
        public let safetyTriggered: Bool
    }

    public struct Watch: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let path: String
    }

    public struct Recovery: Codable, Equatable, Sendable {
        public let status: String
    }

    public struct Continuation: Codable, Equatable, Identifiable, Sendable {
        public var id: String { "\(field):\(token)" }
        public let field: String
        public let token: String
        public let remaining: Int
    }

    public static let empty = AppSnapshot(
        version: 2,
        state: "uninitialized",
        revision: 0,
        freshness: .init(checkedAt: nil),
        summary: .init(selections: 0, current: 0, ready: 0, attention: 0),
        sources: [], userSkills: [], projectSkills: [], skillInventory: [], projects: [], readyWork: [], authorizations: [], attention: [], recentAttention: [], activity: [],
        pendingActions: [], outsideEffects: [], pause: .init(active: false, reason: nil, safetyTriggered: false), watchSet: [], recovery: nil,
        continuations: []
    )

    public func skills(for sourceID: String) -> [UserSkill] {
        userSkills.filter { $0.sourceId == sourceID }
    }

    public var inventorySkills: [InventorySkill] { skillInventory ?? [] }
    public var inventoryProjects: [ProjectInventory] { projects ?? [] }

    func completingPages(_ pages: [String: [AppSnapshot]]) -> AppSnapshot {
        func joined<T>(_ field: String, _ keyPath: KeyPath<AppSnapshot, [T]>) -> [T] {
            self[keyPath: keyPath] + (pages[field] ?? []).flatMap { $0[keyPath: keyPath] }
        }
        let completeSkills = skillInventory.map { first in
            first + (pages["skillInventory"] ?? []).flatMap(\.inventorySkills)
        }
        let completeProjects = projects.map { first in
            first + (pages["projects"] ?? []).flatMap(\.inventoryProjects)
        }
        return AppSnapshot(
            version: version, state: state, revision: revision, freshness: freshness, summary: summary,
            sources: joined("sources", \.sources), userSkills: joined("userSkills", \.userSkills),
            projectSkills: joined("projectSkills", \.projectSkills),
            skillInventory: completeSkills, projects: completeProjects,
            readyWork: joined("readyWork", \.readyWork), authorizations: joined("authorizations", \.authorizations),
            attention: joined("attention", \.attention), recentAttention: joined("recentAttention", \.recentAttention),
            activity: joined("activity", \.activity), pendingActions: joined("pendingActions", \.pendingActions),
            outsideEffects: joined("outsideEffects", \.outsideEffects), pause: pause,
            watchSet: joined("watchSet", \.watchSet), recovery: recovery,
            continuations: continuations?.filter { pages[$0.field] == nil }
        )
    }

    public func attention(for sourceID: String) -> [Attention] {
        let skillIDs = Set(skills(for: sourceID).map(\.id))
        return attention.filter { $0.subjectId == sourceID || skillIDs.contains($0.subjectId) }
    }

    public func isAuthorized(_ selectionID: String) -> Bool {
        authorizations.contains { $0.selectionId == selectionID && $0.active }
    }

    func hasInspectionRelevantChanges(comparedTo prior: AppSnapshot) -> Bool {
        version != prior.version || state != prior.state || summary != prior.summary
            || sources != prior.sources || userSkills != prior.userSkills || projectSkills != prior.projectSkills
            || skillInventory != prior.skillInventory || projects != prior.projects
            || readyWork != prior.readyWork || authorizations != prior.authorizations
            || !Self.sameAttention(attention, prior.attention)
            || !Self.sameAttention(recentAttention, prior.recentAttention)
            || activity != prior.activity || pendingActions != prior.pendingActions
            || outsideEffects != prior.outsideEffects || pause != prior.pause
            || watchSet != prior.watchSet || recovery != prior.recovery
    }

    private static func sameAttention(_ left: [Attention], _ right: [Attention]) -> Bool {
        guard left.count == right.count else { return false }
        return zip(left, right).allSatisfy { current, prior in
            current.id == prior.id && current.subjectId == prior.subjectId && current.code == prior.code
                && current.priority == prior.priority && current.state == prior.state
                && current.stableKey == prior.stableKey && current.condition == prior.condition
                && current.createdAt == prior.createdAt
        }
    }
}

public struct ToolResponse: Decodable, Sendable {
    public let version: Int
    public let ok: Bool
    public let requestId: String?
    public let operation: String?
    public let result: ResultBody?
    public let error: ErrorBody?

    public struct ResultBody: Decodable, Sendable { public let snapshot: AppSnapshot }
    public struct ErrorBody: Decodable, Error, Sendable {
        public let code: String
        public let message: String
        public let disposition: String
    }
}

extension ToolResponse {
    static func validated(_ data: Data, requestId: String, operation: String) throws -> ToolResponse {
        let raw: Any
        do { raw = try JSONSerialization.jsonObject(with: data) }
        catch { throw ToolClientFault.invalidResponse }
        guard let envelope = raw as? [String: Any],
              let ok = envelope["ok"] as? Bool else { throw ToolClientFault.invalidResponse }
        let expected = Set(["version", "ok", "requestId", "operation", ok ? "result" : "error"])
        guard Set(envelope.keys) == expected,
              envelope["version"] as? Int == 2,
              envelope["requestId"] as? String == requestId,
              envelope["operation"] as? String == operation else { throw ToolClientFault.invalidResponse }
        if ok {
            guard let result = envelope["result"] as? [String: Any], Set(result.keys) == Set(["snapshot"]) else {
                throw ToolClientFault.invalidResponse
            }
        } else {
            guard let error = envelope["error"] as? [String: Any],
                  Set(error.keys).isSubset(of: ["code", "message", "disposition", "details"]),
                  ["code", "message", "disposition"].allSatisfy({ error[$0] is String }),
                  error["details"] == nil || error["details"] is [String: Any] else {
                throw ToolClientFault.invalidResponse
            }
        }
        do { return try JSONDecoder().decode(ToolResponse.self, from: data) }
        catch { throw ToolClientFault.invalidResponse }
    }
}
