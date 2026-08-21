import CaddieMacAppCore
import SwiftUI

struct CheckoutSummaryRow: View {
    let section: SkillInventoryPresentation.ProjectSection

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: section.project.checkoutKind == "worktree" ? "arrow.triangle.branch" : "folder")
                .font(.title3).foregroundStyle(section.project.status == "attention" ? .orange : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(title).fontWeight(.semibold)
                    if section.project.lifecycle == "likely-finished" {
                        Text("Likely finished").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text(countLabel).font(.caption).foregroundStyle(.secondary)
                Text(section.gitStateLabel).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            if section.project.status == "attention" {
                Label("Skill review needed", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text("Skills OK").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var title: String {
        if section.project.checkoutKind == "worktree", let branch = section.project.branch {
            return "\(section.project.checkoutKindLabel) · \(branch)"
        }
        return section.project.checkoutKind == "project" ? section.project.name : section.project.checkoutKindLabel
    }

    private var countLabel: String {
        guard let selected = section.project.selectedSkillCount else {
            return "\(section.projectSkills.count) Project Skills"
        }
        return "\(selected) selected · \(section.projectSkills.count) detected"
    }
}
struct CheckoutDetailView: View {
    @ObservedObject var model: AppModel
    let projectID: String
    @State private var confirmsStopTracking = false

    var body: some View {
        let section = currentSection()
        Group {
            if let section {
                checkoutList(section)
            } else {
                MissingInventoryItem(title: "Checkout no longer found")
            }
        }
        .navigationTitle(section?.project.name ?? "Checkout")
        .confirmationDialog("Stop tracking this checkout?", isPresented: $confirmsStopTracking) {
            Button("Stop tracking", role: .destructive) {
                guard let projectRoot = currentSection()?.project.root else { return }
                Task { await model.stopTrackingProject(projectRoot) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(stopTrackingMessage)
        }
    }

    private func checkoutList(_ section: SkillInventoryPresentation.ProjectSection) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label(checkoutTitle(section), systemImage: section.project.checkoutKind == "worktree" ? "arrow.triangle.branch" : "folder")
                        .font(.headline)
                    Text(section.project.root)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 4)
            }

            if section.project.status == "attention" {
                Section("Skills need review") {
                    HStack(alignment: .center, spacing: 12) {
                        Label {
                            Text(reviewMessage(for: section)).foregroundStyle(.primary)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                        Spacer()
                        if section.project.repairAvailable == true {
                            Button("Repair") {
                                guard let current = currentSection(), current.project.repairAvailable == true else { return }
                                Task { await model.repairProject(current.project.root) }
                            }
                            .disabled(model.isPreview)
                        }
                        if section.project.issueCode == "permission-denied" {
                            Button("Grant Access") { model.grantAccess(to: accessPath(for: section)) }
                                .disabled(model.isPreview)
                        }
                    }
                }
            } else {
                Section {
                    Label("Caddie checked this checkout’s Skills and found no issues.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }

            Section("Skills available here") {
                NavigationLink {
                    CheckoutSkillsView(model: model, projectID: projectID, scope: .project)
                } label: {
                    CheckoutSkillGroupRow(
                        title: "Project Skills",
                        message: projectSkillMessage(section),
                        count: section.projectSkills.count,
                        symbol: "folder.badge.gearshape"
                    )
                }
                NavigationLink {
                    CheckoutSkillsView(model: model, projectID: projectID, scope: .user)
                } label: {
                    CheckoutSkillGroupRow(
                        title: "User Skills",
                        message: "Available in all projects unless replaced here",
                        count: section.inheritedUserSkills.count,
                        symbol: "person.crop.circle"
                    )
                }
            }

            Section("Checkout details") {
                DetailValue(label: "Type", value: section.project.checkoutKindLabel)
                if let branch = section.project.branch { DetailValue(label: "Branch", value: branch) }
                if section.project.overrideCount > 0 {
                    DetailValue(label: "Skill replacements", value: "\(section.project.overrideCount)")
                }
                if let mainProjectRoot = section.project.mainProjectRoot, mainProjectRoot != section.project.root {
                    DetailValue(label: "Main checkout", value: mainProjectRoot)
                }
            }

            Section("Git") {
                if let workingTreeClean = section.project.workingTreeClean {
                    DetailValue(label: "Working tree", value: workingTreeClean ? "Clean" : "Has changes")
                }
                if let upstreamState = section.project.upstreamState {
                    DetailValue(label: "Upstream branch", value: upstreamState == "gone" ? "Gone" : upstreamState.capitalized)
                }
                if let included = section.project.includedInDefaultBranch {
                    DetailValue(label: "Branch changes in default branch", value: included ? "Yes" : "No")
                }
                if let lifecycle = section.project.lifecycle {
                    DetailValue(label: "Work", value: lifecycle == "likely-finished" ? "May be finished" : "Active")
                }
            }

            Section("Tracking") {
                Button("Stop tracking this checkout…", role: .destructive) { confirmsStopTracking = true }
                    .disabled(model.isPreview)
            }
        }
    }

    private func currentSection() -> SkillInventoryPresentation.ProjectSection? {
        model.inventoryPresentation.projects.first { $0.project.id == projectID }
    }

    private func checkoutTitle(_ section: SkillInventoryPresentation.ProjectSection) -> String {
        if let branch = section.project.branch {
            return "\(section.project.checkoutKindLabel) · \(branch)"
        }
        return section.project.checkoutKindLabel
    }

    private func projectSkillMessage(_ section: SkillInventoryPresentation.ProjectSection) -> String {
        let replacements = section.projectSkills.filter { $0.shadowsSkillId != nil }.map(\.name)
        guard !replacements.isEmpty else { return "Used only in this checkout" }
        return "Replaces User Skills: \(replacements.joined(separator: ", "))"
    }

    private var stopTrackingMessage: String {
        guard let projectRoot = currentSection()?.project.root else {
            return "This checkout is no longer in Caddie."
        }
        return "Caddie will forget \(projectRoot). The folder, Git worktree, Skills, and project files will stay unchanged."
    }

    private func reviewMessage(for section: SkillInventoryPresentation.ProjectSection) -> String {
        switch section.project.issueCode {
        case "legacy-project-scope":
            return "This checkout has an older Caddie record. Repair it after every owned Skill matches."
        case "invalid-ledger-content":
            return "The Skill list does not match this checkout’s Caddie record."
        case "missing-content":
            return "A selected Skill or source folder is missing."
        case "permission-denied":
            return "Caddie cannot read this checkout’s Skill folder."
        case "source-unavailable":
            return "Caddie could not inspect this checkout."
        default:
            return "Caddie cannot verify this checkout’s Skill record."
        }
    }

    private func accessPath(for section: SkillInventoryPresentation.ProjectSection) -> String {
        section.projectSkills.compactMap(\.permissionFolder).first ?? section.project.root
    }
}

private enum CheckoutSkillScope {
    case project
    case user

    var title: String { self == .project ? "Project Skills" : "User Skills" }
}

private struct CheckoutSkillsView: View {
    @ObservedObject var model: AppModel
    let projectID: String
    let scope: CheckoutSkillScope
    @State private var query = ""

    var body: some View {
        let skills = filteredSkills
        List {
            if skills.isEmpty {
                EmptyInventoryView(
                    title: query.isEmpty ? "No \(scope.title)" : "No matching Skills",
                    message: query.isEmpty ? emptyMessage : "Try a different search.",
                    symbol: "magnifyingglass"
                )
            } else {
                Section {
                    ForEach(skills) { skill in
                        NavigationLink {
                            SkillDetailView(model: model, skillID: skill.id)
                        } label: {
                            SkillSummaryRow(skill: skill)
                        }
                    }
                } header: {
                    Text(guideTitle)
                } footer: {
                    Text(guideMessage)
                }
            }
        }
        .searchable(text: $query, prompt: "Search \(scope.title)")
        .navigationTitle(scope.title)
    }

    private var section: SkillInventoryPresentation.ProjectSection? {
        model.inventoryPresentation.projects.first { $0.project.id == projectID }
    }

    private var filteredSkills: [AppSnapshot.InventorySkill] {
        let all = scope == .project ? section?.projectSkills ?? [] : section?.inheritedUserSkills ?? []
        guard !query.isEmpty else { return all }
        return all.filter { $0.matches(query) }
    }

    private var guideTitle: String {
        scope == .project ? "Used only in this checkout" : "Available in all projects"
    }

    private var guideMessage: String {
        scope == .project
            ? "A Project Skill takes the place of a User Skill with the same name."
            : "This list leaves out User Skills replaced by a Project Skill here."
    }

    private var emptyMessage: String {
        scope == .project ? "This checkout has no Project Skills." : "No User Skills apply to this checkout."
    }
}

private struct CheckoutSkillGroupRow: View {
    let title: String
    let message: String
    let count: Int
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title3).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).fontWeight(.semibold)
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(count)").font(.title3).foregroundStyle(.secondary)
        }
    }
}


private extension AppSnapshot.ProjectInventory {
    var checkoutKindLabel: String {
        switch checkoutKind {
        case "main": return "Main"
        case "worktree": return "Worktree"
        default: return "Project"
        }
    }
}
