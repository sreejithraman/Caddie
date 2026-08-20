import Foundation

public struct SkillInventoryPresentation: Equatable, Sendable {
    public struct ProjectGroup: Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let checkouts: [ProjectSection]

        public var needsReview: Bool { checkouts.contains { $0.project.status == "attention" } }
    }

    public struct ProjectSection: Equatable, Identifiable, Sendable {
        public let project: AppSnapshot.ProjectInventory
        public let projectSkills: [AppSnapshot.InventorySkill]
        public let inheritedUserSkills: [AppSnapshot.InventorySkill]

        public var id: String { project.id }
    }

    public struct SourceSection: Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let location: String
        public let type: String
        public let skills: [AppSnapshot.InventorySkill]

        public var skillCountLabel: String {
            "\(skills.count) \(skills.count == 1 ? "skill" : "skills")"
        }
    }

    public struct ReadySkill: Equatable, Identifiable, Sendable {
        public let work: AppSnapshot.ReadyWork
        public let name: String
        public let sourceName: String?

        public var id: String { work.id }
    }

    public struct RecentActivity: Equatable, Identifiable, Sendable {
        public let activity: AppSnapshot.Activity
        public let title: String
        public let subject: String

        public var id: String { activity.id }
    }

    public let userSkills: [AppSnapshot.InventorySkill]
    public let userSkillAttentionCount: Int
    public let projects: [ProjectSection]
    public let projectGroups: [ProjectGroup]
    public let sources: [SourceSection]
    public let readySkills: [ReadySkill]
    public let recentActivity: [RecentActivity]
    public let isAvailable: Bool
    public let durableAttentionCount: Int
    public let inventoryOnlyUserReviewCount: Int
    public let projectReviewCount: Int

    public var reviewCount: Int { durableAttentionCount + inventoryOnlyUserReviewCount + projectReviewCount }
    public var needsReview: Bool { reviewCount > 0 }

    public init(snapshot: AppSnapshot) {
        isAvailable = snapshot.skillInventory != nil && snapshot.projects != nil
        let inventory = snapshot.inventorySkills
        let presentedUserSkills = inventory
            .filter { $0.scope == "user" }
            .sorted(by: Self.skillOrder)
        userSkills = presentedUserSkills
        userSkillAttentionCount = presentedUserSkills.filter { $0.status == "attention" }.count
        inventoryOnlyUserReviewCount = presentedUserSkills.filter(\.needsStandaloneInventoryReview).count

        let presentedProjects = snapshot.inventoryProjects.map { project in
            let projectSkills = inventory
                .filter { $0.scope == "project" && $0.projectRoot == project.root }
                .sorted(by: Self.skillOrder)
            let projectNames = Set(projectSkills.map(\.name))
            let inherited = presentedUserSkills
                .filter { $0.enabled && !projectNames.contains($0.name) }
                .sorted(by: Self.skillOrder)
            return ProjectSection(project: project, projectSkills: projectSkills, inheritedUserSkills: inherited)
        }.sorted {
            let order = $0.project.name.localizedCaseInsensitiveCompare($1.project.name)
            if order != .orderedSame { return order == .orderedAscending }
            if $0.project.name != $1.project.name { return $0.project.name < $1.project.name }
            return $0.project.root < $1.project.root
        }
        projects = presentedProjects
        projectGroups = Dictionary(grouping: presentedProjects) { section in
            section.project.repositoryId ?? section.project.id
        }.map { repositoryID, sections in
            let checkouts = sections.sorted(by: Self.checkoutOrder)
            let main = checkouts.first { $0.project.checkoutKind == "main" }
            let namedRoot = main?.project.mainProjectRoot ?? checkouts.first?.project.mainProjectRoot
            let name = namedRoot.map { URL(fileURLWithPath: $0).lastPathComponent }
                ?? main?.project.name ?? checkouts.first?.project.name ?? "Project"
            return ProjectGroup(id: repositoryID, name: name, checkouts: checkouts)
        }.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            if order != .orderedSame { return order == .orderedAscending }
            return $0.id < $1.id
        }
        durableAttentionCount = snapshot.summary.attention
        projectReviewCount = presentedProjects.filter { $0.project.status == "attention" }.count

        var grouped: [String: [AppSnapshot.InventorySkill]] = [:]
        for skill in inventory where !Self.isProjectPermissionPlaceholder(skill) {
            grouped[skill.origin?.id ?? "unmanaged", default: []].append(skill)
        }
        sources = grouped.map { id, skills in
            let origin = skills.compactMap(\.origin).first
            return SourceSection(
                id: id,
                name: origin?.name ?? "Unmanaged",
                location: origin?.location ?? "Installed skill folders",
                type: origin?.type ?? "unmanaged",
                skills: skills.sorted(by: Self.skillOrder)
            )
        }.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            if order != .orderedSame { return order == .orderedAscending }
            if $0.name != $1.name { return $0.name < $1.name }
            if $0.location != $1.location { return $0.location < $1.location }
            return $0.id < $1.id
        }

        var skillsBySelectionID: [String: AppSnapshot.InventorySkill] = [:]
        for skill in inventory {
            if let selectionID = skill.selectionId, skillsBySelectionID[selectionID] == nil {
                skillsBySelectionID[selectionID] = skill
            }
        }
        readySkills = snapshot.readyWork.map { work in
            let skill = skillsBySelectionID[work.selectionId]
            return ReadySkill(
                work: work,
                name: skill?.name ?? work.selectionId.split(separator: ":").last.map(String.init) ?? work.selectionId,
                sourceName: skill?.origin?.name
            )
        }.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            if order != .orderedSame { return order == .orderedAscending }
            return $0.id < $1.id
        }
        var attentionSubjects: [String: String] = [:]
        for attention in snapshot.attention + snapshot.recentAttention where attentionSubjects[attention.id] == nil {
            attentionSubjects[attention.id] = attention.subjectId
        }
        recentActivity = snapshot.activity.map { activity in
            let subjectID = attentionSubjects[activity.subjectId] ?? activity.subjectId
            let subject = Self.activitySubject(
                subjectID,
                skillsBySelectionID: skillsBySelectionID,
                projects: presentedProjects
            )
            return RecentActivity(
                activity: activity,
                title: Self.activityTitle(activity.kind),
                subject: subject
            )
        }
    }

    private static func checkoutOrder(_ left: ProjectSection, _ right: ProjectSection) -> Bool {
        let rank = ["main": 0, "project": 1, "worktree": 2]
        let leftRank = rank[left.project.checkoutKind ?? "project"] ?? 3
        let rightRank = rank[right.project.checkoutKind ?? "project"] ?? 3
        if leftRank != rightRank { return leftRank < rightRank }
        if left.project.lifecycle != right.project.lifecycle { return left.project.lifecycle != "likely-finished" }
        return left.project.root < right.project.root
    }

    private static func activityTitle(_ kind: String) -> String {
        switch kind {
        case "reconciled": return "Skill updated"
        case "attention-engaged": return "Review needed"
        case "attention-resolved", "attention-closed": return "Review resolved"
        case "outside-effect-reported": return "Notice sent"
        case "action-invoked": return "Action finished"
        default:
            return kind.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private static func activitySubject(
        _ subjectID: String,
        skillsBySelectionID: [String: AppSnapshot.InventorySkill],
        projects: [ProjectSection]
    ) -> String {
        if let skill = skillsBySelectionID[subjectID] { return skill.name }
        if let project = projects.first(where: { $0.project.id == subjectID || $0.project.root == subjectID }) {
            return project.project.name
        }
        if subjectID == "tool" || subjectID == "recovery" { return "Caddie" }
        if subjectID.hasPrefix("attention-") { return "Caddie" }
        if subjectID.hasPrefix("/") { return URL(fileURLWithPath: subjectID).lastPathComponent }
        return subjectID.split(separator: ":").last.map(String.init) ?? subjectID
    }

    private static func isProjectPermissionPlaceholder(_ skill: AppSnapshot.InventorySkill) -> Bool {
        guard skill.scope == "project", skill.name == "Project Skills", skill.selectionId == nil,
              skill.permissionFolder == skill.installedPath, let projectRoot = skill.projectRoot else { return false }
        let projectSkillsRoot = URL(fileURLWithPath: projectRoot, isDirectory: true)
            .appendingPathComponent(".agents", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .standardizedFileURL.path
        return URL(fileURLWithPath: skill.installedPath).standardizedFileURL.path == projectSkillsRoot
    }

    private static func skillOrder(_ left: AppSnapshot.InventorySkill, _ right: AppSnapshot.InventorySkill) -> Bool {
        let order = left.name.localizedCaseInsensitiveCompare(right.name)
        if order != .orderedSame { return order == .orderedAscending }
        if left.name != right.name { return left.name < right.name }
        return left.installedPath < right.installedPath
    }
}

extension AppSnapshot.InventorySkill {
    public var statusLabel: String {
        enabled ? updateStatusLabel : "Disabled"
    }

    public var updateStatusLabel: String {
        switch status {
        case "current": return "Up to date"
        case "ready": return "Update available"
        case "manual-only": return "Auto-update off"
        case "unmanaged": return "Not managed"
        case "attention": return "Needs review"
        default: return status.capitalized
        }
    }

    var needsStandaloneInventoryReview: Bool {
        scope == "user" && status == "attention" && selectionId == nil
    }
}
