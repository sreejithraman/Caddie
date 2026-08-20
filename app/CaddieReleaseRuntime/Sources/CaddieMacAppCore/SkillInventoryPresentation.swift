import Foundation

public struct SkillInventoryPresentation: Equatable, Sendable {
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
    public let projects: [ProjectSection]
    public let sources: [SourceSection]

    public init(snapshot: AppSnapshot) {
        let inventory = snapshot.inventorySkills
        let presentedUserSkills = inventory
            .filter { $0.scope == "user" }
            .sorted(by: Self.skillOrder)
        userSkills = presentedUserSkills

        projects = snapshot.inventoryProjects.map { project in
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

        var grouped: [String: [AppSnapshot.InventorySkill]] = [:]
        for skill in inventory where skill.permissionFolder == nil {
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

    private static func skillOrder(_ left: AppSnapshot.InventorySkill, _ right: AppSnapshot.InventorySkill) -> Bool {
        let order = left.name.localizedCaseInsensitiveCompare(right.name)
        if order != .orderedSame { return order == .orderedAscending }
        if left.name != right.name { return left.name < right.name }
        return left.installedPath < right.installedPath
    }
}
