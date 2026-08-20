import Foundation
import XCTest
@testable import CaddieMacAppCore

final class PreviewSnapshotTests: XCTestCase {
    func testLoadsTheNewestInventoryAtOrBeforeTheFrozenState() throws {
        let fixture = try PreviewFixture(snapshotRevision: 3, projectionRevisions: [2, 4])
        defer { fixture.remove() }

        let result = try PreviewSnapshotLoader().load(from: fixture.root)

        XCTAssertEqual(result.revision, 3)
        XCTAssertEqual(result.inventorySkills.map(\.name), ["Skill at 2"])
        XCTAssertEqual(result.inventoryProjects.map(\.name), ["Project at 2"])
    }

    func testRejectsStateWhoseSnapshotRevisionDoesNotMatch() throws {
        let fixture = try PreviewFixture(snapshotRevision: 3, stateRevision: 4, projectionRevisions: [3])
        defer { fixture.remove() }

        XCTAssertThrowsError(try PreviewSnapshotLoader().load(from: fixture.root)) {
            XCTAssertEqual($0 as? PreviewSnapshotFault, .incompatibleFiles)
        }
    }

    func testRejectsInventoryFromOnlyNewerState() throws {
        let fixture = try PreviewFixture(snapshotRevision: 3, projectionRevisions: [4])
        defer { fixture.remove() }

        XCTAssertThrowsError(try PreviewSnapshotLoader().load(from: fixture.root)) {
            XCTAssertEqual($0 as? PreviewSnapshotFault, .incompatibleFiles)
        }
    }
}

private struct PreviewFixture {
    let root: URL

    init(snapshotRevision: Int, stateRevision: Int? = nil, projectionRevisions: [Int]) throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("caddie-preview-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let snapshot = AppSnapshot(
            version: 2, state: "ready", revision: snapshotRevision,
            freshness: .init(checkedAt: "2026-08-20T12:00:00Z"),
            summary: .init(selections: 1, current: 1, ready: 0, attention: 0),
            sources: [], userSkills: [], projectSkills: [], skillInventory: nil, projects: nil,
            readyWork: [], authorizations: [], attention: [], recentAttention: [], activity: [],
            pendingActions: [], outsideEffects: [], pause: .init(active: false, reason: nil, safetyTriggered: false),
            watchSet: [], recovery: nil, continuations: []
        )
        let state = StateFile(version: 2, revision: stateRevision ?? snapshotRevision, snapshot: snapshot)
        let projections = projectionRevisions.map { revision in
            Projection(
                revision: revision,
                skillInventory: [.init(
                    version: 2, id: "skill-\(revision)", scope: "user", projectRoot: nil,
                    name: "Skill at \(revision)", installedPath: "/tmp/skill-\(revision)", enabled: true,
                    managed: false, selectionId: nil, origin: nil, shadowsSkillId: nil,
                    status: "unmanaged", permissionFolder: nil
                )],
                projects: [.init(
                    version: 2, id: "project-\(revision)", name: "Project at \(revision)",
                    root: "/tmp/project-\(revision)", projectSkillCount: 0, inheritedUserSkillCount: 1,
                    overrideCount: 0, status: "current", selectedSkillCount: 0, issueCode: nil,
                    repairAvailable: false, repositoryId: nil, checkoutKind: "project", branch: nil,
                    mainProjectRoot: nil, workingTreeClean: true, upstreamState: nil,
                    includedInDefaultBranch: nil, lifecycle: nil
                )]
            )
        }
        try JSONEncoder().encode(state).write(
            to: root.appendingPathComponent(PreviewSnapshotLoader.stateFileName)
        )
        try JSONEncoder().encode(InventoryFile(version: 1, projections: projections)).write(
            to: root.appendingPathComponent(PreviewSnapshotLoader.inventoryFileName)
        )
    }

    func remove() { try? FileManager.default.removeItem(at: root) }

    private struct StateFile: Encodable {
        let version: Int
        let revision: Int
        let snapshot: AppSnapshot
    }

    private struct InventoryFile: Encodable {
        let version: Int
        let projections: [Projection]
    }

    private struct Projection: Encodable {
        let revision: Int
        let skillInventory: [AppSnapshot.InventorySkill]
        let projects: [AppSnapshot.ProjectInventory]
    }
}
