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
    }

    public let userSkills: [AppSnapshot.InventorySkill]
    public let userSkillAttentionCount: Int
    public let projects: [ProjectSection]
    public let projectGroups: [ProjectGroup]
    public let sources: [SourceSection]
    public let isAvailable: Bool

    public init(snapshot: AppSnapshot) {
        isAvailable = snapshot.skillInventory != nil && snapshot.projects != nil
        let inventory = snapshot.inventorySkills
        let presentedUserSkills = inventory
            .filter { $0.scope == "user" }
            .sorted(by: Self.skillOrder)
        userSkills = presentedUserSkills
        userSkillAttentionCount = presentedUserSkills.filter { $0.status == "attention" }.count

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
    }

    private static func checkoutOrder(_ left: ProjectSection, _ right: ProjectSection) -> Bool {
        let rank = ["main": 0, "project": 1, "worktree": 2]
        let leftRank = rank[left.project.checkoutKind ?? "project"] ?? 3
        let rightRank = rank[right.project.checkoutKind ?? "project"] ?? 3
        if leftRank != rightRank { return leftRank < rightRank }
        if left.project.lifecycle != right.project.lifecycle { return left.project.lifecycle != "likely-finished" }
        return left.project.root < right.project.root
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
