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
    public let readyWork: [ReadyWork]
    public let attention: [Attention]
    public let activity: [Activity]
    public let pendingActions: [PendingAction]
    public let pause: Pause
    public let watchSet: [Watch]
    public let recovery: Recovery?

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

        public struct Intent: Codable, Equatable, Sendable { public let type: String }
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

    public static let empty = AppSnapshot(
        version: 2,
        state: "uninitialized",
        revision: 0,
        freshness: .init(checkedAt: nil),
        summary: .init(selections: 0, current: 0, ready: 0, attention: 0),
        sources: [], userSkills: [], projectSkills: [], readyWork: [], attention: [], activity: [],
        pendingActions: [], pause: .init(active: false, reason: nil, safetyTriggered: false), watchSet: [], recovery: nil
    )

    public func skills(for sourceID: String) -> [UserSkill] {
        userSkills.filter { $0.sourceId == sourceID }
    }

    public func attention(for sourceID: String) -> [Attention] {
        let skillIDs = Set(skills(for: sourceID).map(\.id))
        return attention.filter { $0.subjectId == sourceID || skillIDs.contains($0.subjectId) }
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
