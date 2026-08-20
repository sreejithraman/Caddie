import XCTest
@testable import CaddieMacAppCore

final class SkillInventoryPresentationTests: XCTestCase {
    func testMissingInventoryProjectionIsUnavailableInsteadOfEmpty() throws {
        let data = try JSONEncoder().encode(AppSnapshot.empty)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "skillInventory")
        object.removeValue(forKey: "projects")
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertFalse(presentation.isAvailable)
        XCTAssertEqual(presentation.userSkills, [])
        XCTAssertEqual(presentation.projects, [])
    }

    func testSkillsAreGroupedByUserAndProjectWithOverridesAndInheritedUserSkills() throws {
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: Data(Self.fixture.utf8))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertEqual(presentation.userSkills.map(\.name), ["loose", "shared", "user-only"])
        XCTAssertEqual(presentation.projects.map(\.project.name), ["Example"])
        XCTAssertEqual(presentation.projects[0].projectSkills.map(\.name), ["project-only", "shared"])
        XCTAssertEqual(presentation.projects[0].inheritedUserSkills.map(\.name), ["loose", "user-only"])
        XCTAssertNotNil(presentation.projects[0].projectSkills.first { $0.name == "shared" }?.shadowsSkillId)
        XCTAssertEqual(presentation.projectGroups.map(\.name), ["Example"])
    }

    func testCheckoutsFromOneRepositoryStayInOneProjectGroupWithMainFirst() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        object["projects"] = [
            ["version": 2, "id": "worktree", "name": "Example", "root": "/tmp/worktrees/example", "projectSkillCount": 0,
             "inheritedUserSkillCount": 3, "overrideCount": 0, "status": "attention", "repositoryId": "/tmp/repo/.git",
             "checkoutKind": "worktree", "branch": "codex/change", "mainProjectRoot": "/tmp/example", "lifecycle": "likely-finished",
             "issueCode": "legacy-project-scope", "repairAvailable": true, "selectedSkillCount": 0],
            ["version": 2, "id": "main", "name": "Example", "root": "/tmp/example", "projectSkillCount": 2,
             "inheritedUserSkillCount": 2, "overrideCount": 1, "status": "current", "repositoryId": "/tmp/repo/.git",
             "checkoutKind": "main", "branch": "main", "mainProjectRoot": "/tmp/example", "lifecycle": "active",
             "issueCode": NSNull(), "repairAvailable": false, "selectedSkillCount": 2],
        ]
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let groups = SkillInventoryPresentation(snapshot: snapshot).projectGroups

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].checkouts.map(\.project.id), ["main", "worktree"])
        XCTAssertTrue(groups[0].needsReview)

        let presentation = SkillInventoryPresentation(snapshot: snapshot)
        XCTAssertEqual(presentation.durableAttentionCount, 0)
        XCTAssertEqual(presentation.projectReviewCount, 1)
        XCTAssertEqual(presentation.reviewCount, 1)
        XCTAssertTrue(presentation.needsReview)
    }

    func testReviewCountAddsDurableAttentionAndProjectReviewWithoutCountingInventoryRows() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        object["summary"] = ["selections": 2, "current": 1, "ready": 0, "attention": 2]
        var projects = try XCTUnwrap(object["projects"] as? [[String: Any]])
        projects[0]["status"] = "attention"
        object["projects"] = projects
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertEqual(presentation.durableAttentionCount, 2)
        XCTAssertEqual(presentation.projectReviewCount, 1)
        XCTAssertEqual(presentation.reviewCount, 3)
        XCTAssertTrue(presentation.needsReview)
    }

    func testAppStatusUsesOnePriorityAcrossMenuAndWindow() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        object["summary"] = ["selections": 2, "current": 1, "ready": 0, "attention": 1]
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        XCTAssertEqual(CaddieAppStatus(snapshot: snapshot, isRunningCycle: true, updatesPaused: true), .needsReview)
        XCTAssertEqual(CaddieAppStatus(snapshot: snapshot, isRunningCycle: false, updatesPaused: true), .needsReview)
        XCTAssertEqual(CaddieAppStatus(snapshot: snapshot, isRunningCycle: false, updatesPaused: false), .needsReview)
        XCTAssertEqual(CaddieAppStatus(snapshot: .empty, isRunningCycle: false, updatesPaused: false), .waiting)
    }

    func testSourcesUseGitOrFolderLocationAndKeepUnmanagedUserSkillsSeparate() throws {
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: Data(Self.fixture.utf8))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)
        let sources = presentation.sources

        XCTAssertEqual(sources.map(\.name), ["Project Source", "User Source"])
        XCTAssertEqual(sources.first { $0.name == "User Source" }?.location, "/tmp/user-source")
        XCTAssertEqual(sources.first { $0.name == "Project Source" }?.location, "https://example.test/skills.git")
        XCTAssertEqual(sources.first { $0.name == "Project Source" }?.skillCountLabel, "2 skills")
        XCTAssertEqual(presentation.unmanagedUserSkills.map(\.name), ["loose"])
    }

    func testReadyWorkUsesSkillNamesInsteadOfSelectionIDs() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        object["readyWork"] = [
            ["id": "ready-user", "selectionId": "user-source:user-only", "kind": "update", "authorized": true],
            ["id": "ready-missing", "selectionId": "missing-source:unknown", "kind": "update", "authorized": false],
        ]
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let ready = SkillInventoryPresentation(snapshot: snapshot).readySkills

        XCTAssertEqual(ready.map(\.name), ["unknown", "user-only"])
        XCTAssertEqual(ready.first { $0.work.id == "ready-user" }?.sourceName, "User Source")
        XCTAssertNil(ready.first { $0.work.id == "ready-missing" }?.sourceName)
    }

    func testRecentActivityUsesPlainLabelsAndSkillNames() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        object["activity"] = [
            ["id": "activity-1", "kind": "reconciled", "subjectId": "user-source:user-only", "createdAt": "2026-08-04T12:01:00Z"],
            ["id": "activity-2", "kind": "action-invoked", "subjectId": "attention-missing", "createdAt": "2026-08-04T12:02:00Z"],
        ]
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let activity = try XCTUnwrap(SkillInventoryPresentation(snapshot: snapshot).recentActivity.first)

        XCTAssertEqual(activity.title, "Skill updated")
        XCTAssertEqual(activity.subject, "user-only")
        XCTAssertEqual(SkillInventoryPresentation(snapshot: snapshot).recentActivity.last?.subject, "Caddie")
    }

    func testSkillStatusLabelsExplainWhatTheStatusMeans() throws {
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: Data(Self.fixture.utf8))
        let skills = snapshot.inventorySkills

        XCTAssertEqual(skills.first { $0.status == "current" }?.statusLabel, "Skills OK")
        XCTAssertEqual(skills.first { $0.status == "unmanaged" }?.statusLabel, "Not managed")
        XCTAssertEqual(skills.first { !$0.enabled }?.statusLabel, "Disabled")
        XCTAssertEqual(skills.first { !$0.enabled }?.updateStatusLabel, "Skills OK")
    }

    func testProjectPermissionPlaceholderStaysOutOfTheUnmanagedSourceGroup() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var inventory = try XCTUnwrap(object["skillInventory"] as? [[String: Any]])
        inventory.append([
            "version": 2, "id": "permission", "scope": "project", "projectRoot": "/tmp/example",
            "name": "Project Skills", "installedPath": "/tmp/example/.agents/skills", "enabled": true,
            "managed": false, "selectionId": NSNull(), "origin": NSNull(), "shadowsSkillId": NSNull(),
            "status": "attention", "permissionFolder": "/tmp/example/.agents/skills",
        ])
        inventory.append([
            "version": 2, "id": "named-project-skills", "scope": "project", "projectRoot": "/tmp/example",
            "name": "Project Skills", "installedPath": "/tmp/example/.agents/skills/Project Skills", "enabled": true,
            "managed": false, "selectionId": NSNull(), "origin": NSNull(), "shadowsSkillId": NSNull(),
            "status": "attention", "permissionFolder": "/tmp/example/.agents/skills/Project Skills",
        ])
        object["skillInventory"] = inventory
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertEqual(presentation.projects[0].projectSkills.first { $0.id == "permission" }?.permissionFolder,
                       "/tmp/example/.agents/skills")
        XCTAssertFalse(presentation.sources.flatMap(\.skills).contains { $0.id == "permission" })
        XCTAssertFalse(presentation.sources.flatMap(\.skills).contains { $0.id == "named-project-skills" })
    }

    func testUnreadableUserSkillStaysInUnmanagedAndMarksTheUserHeaderForAttention() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var inventory = try XCTUnwrap(object["skillInventory"] as? [[String: Any]])
        inventory.append([
            "version": 2, "id": "denied-user", "scope": "user", "projectRoot": NSNull(),
            "name": "denied", "installedPath": "/tmp/user/denied", "enabled": true,
            "managed": false, "selectionId": NSNull(), "origin": NSNull(), "shadowsSkillId": NSNull(),
            "status": "attention", "permissionFolder": "/tmp/user/denied",
        ])
        object["skillInventory"] = inventory
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertEqual(presentation.userSkillAttentionCount, 1)
        XCTAssertEqual(presentation.inventoryOnlyUserReviewCount, 1)
        XCTAssertEqual(presentation.reviewCount, 1)
        XCTAssertEqual(CaddieAppStatus(snapshot: snapshot, isRunningCycle: false, updatesPaused: false), .needsReview)
        XCTAssertEqual(presentation.unmanagedUserSkills.map(\.name), ["denied", "loose"])
    }

    func testOneLogicalSourceGroupsGitCheckoutsAndListsEachUse() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var inventory = try XCTUnwrap(object["skillInventory"] as? [[String: Any]])
        inventory.append([
            "version": 2, "id": "worktree-shared", "scope": "project", "projectRoot": "/tmp/worktree",
            "name": "shared", "installedPath": "/tmp/worktree/.agents/skills/shared", "enabled": true,
            "managed": true, "selectionId": "worktree-source:shared",
            "origin": ["id": "origin-user", "sourceId": "worktree-source", "name": "User Source", "type": "local",
                       "gitUrl": NSNull(), "localFolder": "/tmp/worktree/skills", "selectedPath": "shared"],
            "shadowsSkillId": NSNull(), "status": "current",
        ])
        object["skillInventory"] = inventory
        var projects = try XCTUnwrap(object["projects"] as? [[String: Any]])
        projects.append([
            "version": 2, "id": "project-worktree", "name": "Example", "root": "/tmp/worktree",
            "projectSkillCount": 1, "inheritedUserSkillCount": 2, "overrideCount": 0, "status": "current",
            "repositoryId": "repo", "checkoutKind": "worktree", "branch": "feature",
            "mainProjectRoot": "/tmp/example", "workingTreeClean": true,
        ])
        object["projects"] = projects
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let source = try XCTUnwrap(SkillInventoryPresentation(snapshot: snapshot).sources.first { $0.id == "origin-user" })

        XCTAssertEqual(source.locations, ["/tmp/user-source", "/tmp/worktree/skills"])
        XCTAssertTrue(source.isRepository)
        XCTAssertEqual(source.summaryLabel, "2 source folders")
        XCTAssertEqual(source.skills.map(\.name), ["shared", "user-only"])
        XCTAssertEqual(source.uses.count, 3)
        XCTAssertEqual(source.uses.map(\.targetName), ["User Skills", "Worktree · feature", "User Skills"])
        XCTAssertEqual(source.uses.compactMap(\.targetPath), ["/tmp/worktree"])
    }

    func testProjectSkillStoredInsideItsSourceFolderStaysOutOfSources() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var inventory = try XCTUnwrap(object["skillInventory"] as? [[String: Any]])
        inventory.append([
            "version": 2, "id": "in-place", "scope": "project", "projectRoot": "/tmp/example",
            "name": "in-place", "installedPath": "/tmp/example/.agents/skills/in-place", "enabled": true,
            "managed": true, "selectionId": "project:in-place",
            "origin": ["id": "in-place-source", "sourceId": "project", "name": "Project", "type": "local",
                       "gitUrl": NSNull(), "localFolder": "/tmp/example/.agents/skills", "selectedPath": "in-place"],
            "shadowsSkillId": NSNull(), "status": "current",
        ])
        object["skillInventory"] = inventory
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let presentation = SkillInventoryPresentation(snapshot: snapshot)

        XCTAssertFalse(presentation.sources.contains { $0.id == "in-place-source" })
        XCTAssertTrue(presentation.projects.flatMap(\.projectSkills).contains { $0.id == "in-place" })
    }

    func testSkillAndGitLabelsStayIndependent() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var projects = try XCTUnwrap(object["projects"] as? [[String: Any]])
        projects[0]["workingTreeClean"] = false
        projects[0]["status"] = "current"
        object["projects"] = projects
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let project = try XCTUnwrap(SkillInventoryPresentation(snapshot: snapshot).projects.first)

        XCTAssertEqual(project.skillStateLabel, "Skills OK")
        XCTAssertEqual(project.gitStateLabel, "Git: Has changes")
    }

    func testSourcesWithMatchingNamesAndLocationsUseTheirIDsAsTheFinalSortKey() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
        var inventory = try XCTUnwrap(object["skillInventory"] as? [[String: Any]])
        for id in ["origin-z", "origin-a"] {
            inventory.append([
                "version": 2, "id": "skill-\(id)", "scope": "user", "projectRoot": NSNull(),
                "name": "skill-\(id)", "installedPath": "/tmp/user/skill-\(id)", "enabled": true,
                "managed": true, "selectionId": "selection-\(id)",
                "origin": ["id": id, "sourceId": "source-\(id)", "name": "Same Source", "type": "local",
                           "gitUrl": NSNull(), "localFolder": "/tmp/same-source", "selectedPath": "skill-\(id)"],
                "shadowsSkillId": NSNull(), "status": "current",
            ])
        }
        object["skillInventory"] = inventory
        let snapshot = try JSONDecoder().decode(AppSnapshot.self, from: JSONSerialization.data(withJSONObject: object))

        let tiedSources = SkillInventoryPresentation(snapshot: snapshot).sources.filter { $0.name == "Same Source" }

        XCTAssertEqual(tiedSources.map(\.id), ["origin-a", "origin-z"])
    }

    private static let fixture = #"""
    {
      "version":2,"state":"ready","revision":1,"freshness":{"checkedAt":"2026-08-04T12:00:00Z"},
      "summary":{"selections":2,"current":2,"ready":0,"attention":0},
      "sources":[],"userSkills":[],"projectSkills":[],
      "skillInventory":[
        {"version":2,"id":"user-shared","scope":"user","projectRoot":null,"name":"shared","installedPath":"/tmp/user/shared","enabled":true,"managed":true,"selectionId":"user-source:shared","origin":{"id":"origin-user","sourceId":"user-source","name":"User Source","type":"local","gitUrl":null,"localFolder":"/tmp/user-source","selectedPath":"shared"},"shadowsSkillId":null,"status":"current"},
        {"version":2,"id":"user-only","scope":"user","projectRoot":null,"name":"user-only","installedPath":"/tmp/user/user-only","enabled":true,"managed":true,"selectionId":"user-source:user-only","origin":{"id":"origin-user","sourceId":"user-source","name":"User Source","type":"local","gitUrl":null,"localFolder":"/tmp/user-source","selectedPath":"user-only"},"shadowsSkillId":null,"status":"current"},
        {"version":2,"id":"loose","scope":"user","projectRoot":null,"name":"loose","installedPath":"/tmp/user/loose","enabled":true,"managed":false,"selectionId":null,"origin":null,"shadowsSkillId":null,"status":"unmanaged"},
        {"version":2,"id":"project-shared","scope":"project","projectRoot":"/tmp/example","name":"shared","installedPath":"/tmp/example/.agents/skills/shared","enabled":false,"managed":true,"selectionId":"project-source:shared","origin":{"id":"origin-project","sourceId":"project-source","name":"Project Source","type":"git","gitUrl":"https://example.test/skills.git","localFolder":null,"selectedPath":"shared"},"shadowsSkillId":"user-shared","status":"current"},
        {"version":2,"id":"project-only","scope":"project","projectRoot":"/tmp/example","name":"project-only","installedPath":"/tmp/example/.agents/skills/project-only","enabled":true,"managed":true,"selectionId":"project-source:project-only","origin":{"id":"origin-project","sourceId":"project-source","name":"Project Source","type":"git","gitUrl":"https://example.test/skills.git","localFolder":null,"selectedPath":"project-only"},"shadowsSkillId":null,"status":"current"}
      ],
      "projects":[{"version":2,"id":"project-example","name":"Example","root":"/tmp/example","projectSkillCount":2,"inheritedUserSkillCount":2,"overrideCount":1,"status":"current"}],
      "readyWork":[],"authorizations":[],"attention":[],"recentAttention":[],"activity":[],"pendingActions":[],"outsideEffects":[],
      "pause":{"active":false,"safetyTriggered":false},"watchSet":[]
    }
    """#
}
