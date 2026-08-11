import CaddieMacAppCore
import SwiftUI

struct UserSkillsPage: View {
    @ObservedObject var model: AppModel
    let skills: [AppSnapshot.InventorySkill]
    let isAvailable: Bool
    @State private var query = ""

    var body: some View {
        List {
            if !isAvailable {
                EmptyInventoryView(
                    title: "Skill inventory is not ready",
                    message: "Use Sync now to check your User Skills.",
                    symbol: "arrow.clockwise"
                )
            } else if filteredSkills.isEmpty {
                EmptyInventoryView(
                    title: query.isEmpty ? "No User Skills" : "No matching User Skills",
                    message: query.isEmpty ? "Caddie did not find any User Skills." : "Try a different search.",
                    symbol: "magnifyingglass"
                )
            } else {
                ForEach(filteredSkills) { skill in
                    NavigationLink {
                        SkillDetailView(model: model, skill: skill)
                    } label: {
                        SkillSummaryRow(skill: skill)
                            .contentShape(Rectangle())
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search User Skills")
        .navigationTitle("User Skills")
    }

    private var filteredSkills: [AppSnapshot.InventorySkill] {
        guard !query.isEmpty else { return skills }
        return skills.filter { skill in
            skill.name.localizedCaseInsensitiveContains(query)
                || skill.origin?.name.localizedCaseInsensitiveContains(query) == true
                || skill.installedPath.localizedCaseInsensitiveContains(query)
        }
    }
}

struct ProjectsPage: View {
    @ObservedObject var model: AppModel
    let groups: [SkillInventoryPresentation.ProjectGroup]
    let isAvailable: Bool
    @State private var query = ""

    var body: some View {
        List {
            if !isAvailable {
                EmptyInventoryView(
                    title: "Project inventory is not ready",
                    message: "Use Sync now to check your projects.",
                    symbol: "arrow.clockwise"
                )
            } else if filteredGroups.isEmpty {
                EmptyInventoryView(
                    title: query.isEmpty ? "No Projects" : "No matching Projects",
                    message: query.isEmpty ? "Caddie did not find any projects." : "Try a different search.",
                    symbol: "magnifyingglass"
                )
            } else {
                ForEach(filteredGroups) { group in
                    NavigationLink {
                        ProjectDetailView(model: model, group: group)
                    } label: {
                        ProjectSummaryRow(group: group)
                            .contentShape(Rectangle())
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search Projects")
        .navigationTitle("Projects")
    }

    private var filteredGroups: [SkillInventoryPresentation.ProjectGroup] {
        guard !query.isEmpty else { return groups }
        return groups.filter { group in
            group.name.localizedCaseInsensitiveContains(query)
                || group.checkouts.contains { checkout in
                    checkout.project.root.localizedCaseInsensitiveContains(query)
                        || checkout.project.branch?.localizedCaseInsensitiveContains(query) == true
                }
        }
    }
}

struct SourcesPage: View {
    @ObservedObject var model: AppModel
    let sources: [SkillInventoryPresentation.SourceSection]
    let isAvailable: Bool
    @State private var query = ""

    var body: some View {
        List {
            if !isAvailable {
                EmptyInventoryView(
                    title: "Source inventory is not ready",
                    message: "Use Sync now to check your skill sources.",
                    symbol: "arrow.clockwise"
                )
            } else if filteredSources.isEmpty {
                EmptyInventoryView(
                    title: query.isEmpty ? "No Sources" : "No matching Sources",
                    message: query.isEmpty ? "Caddie did not find any skill sources." : "Try a different search.",
                    symbol: "magnifyingglass"
                )
            } else {
                ForEach(filteredSources) { source in
                    NavigationLink {
                        SourceDetailView(model: model, source: source)
                    } label: {
                        SourceSummaryRow(source: source)
                            .contentShape(Rectangle())
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search Sources")
        .navigationTitle("Sources")
    }

    private var filteredSources: [SkillInventoryPresentation.SourceSection] {
        guard !query.isEmpty else { return sources }
        return sources.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.location.localizedCaseInsensitiveContains(query)
        }
    }
}

struct ProjectSummaryRow: View {
    let group: SkillInventoryPresentation.ProjectGroup

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "folder.fill")
                .font(.title3).foregroundStyle(group.needsReview ? .orange : .accentColor)
            VStack(alignment: .leading, spacing: 4) {
                Text(group.name).fontWeight(.semibold)
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if group.needsReview {
                Label("Needs review", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text("Current").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 7)
    }

    private var summary: String {
        let count = group.checkouts.reduce(0) { $0 + $1.projectSkills.count }
        return "\(group.checkouts.count) \(group.checkouts.count == 1 ? "checkout" : "checkouts") · \(count) Project Skills"
    }
}

private struct ProjectDetailView: View {
    @ObservedObject var model: AppModel
    let group: SkillInventoryPresentation.ProjectGroup

    var body: some View {
        List {
            Section {
                ForEach(group.checkouts) { checkout in
                    NavigationLink {
                        CheckoutDetailView(model: model, section: checkout)
                    } label: {
                        CheckoutSummaryRow(section: checkout)
                            .contentShape(Rectangle())
                    }
                }
            } header: {
                Text("Checkouts")
            } footer: {
                Text("Main and worktree checkouts share a project because they belong to the same Git repository.")
            }
        }
        .navigationTitle(group.name)
    }
}

private struct CheckoutSummaryRow: View {
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
            }
            Spacer()
            if section.project.status == "attention" {
                Label("Needs review", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text("Current").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 7)
    }

    private var title: String {
        switch section.project.checkoutKind {
        case "main": return "Main"
        case "worktree": return section.project.branch.map { "Worktree · \($0)" } ?? "Worktree"
        default: return section.project.name
        }
    }

    private var countLabel: String {
        guard let selected = section.project.selectedSkillCount else {
            return "\(section.projectSkills.count) Project Skills"
        }
        return "\(selected) selected · \(section.projectSkills.count) detected"
    }
}

private struct CheckoutDetailView: View {
    @ObservedObject var model: AppModel
    let section: SkillInventoryPresentation.ProjectSection
    @State private var confirmsStopTracking = false

    var body: some View {
        List {
            Section("Checkout") {
                DetailValue(label: "Kind", value: checkoutKind)
                if let branch = section.project.branch { DetailValue(label: "Branch", value: branch) }
                DetailValue(label: "Folder", value: section.project.root)
                DetailValue(label: "Status", value: section.project.status == "attention" ? "Needs review" : "Current")
            }

            if section.project.status == "attention" {
                Section("Needs review") {
                    Label(reviewMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    HStack {
                        if section.project.repairAvailable == true {
                            Button("Repair") { Task { await model.repairProject(section.project.root) } }
                        }
                        if section.project.issueCode == "source-unavailable" || section.project.issueCode == "permission-denied" {
                            Button("Grant Access") { model.grantAccess(to: section.project.root) }
                        }
                        Button("Stop tracking…", role: .destructive) { confirmsStopTracking = true }
                    }
                }
            }

            Section("Project Skills") {
                if section.projectSkills.isEmpty {
                    Text("No Project Skills found").foregroundStyle(.secondary)
                }
                ForEach(section.projectSkills) { skill in
                    NavigationLink {
                        SkillDetailView(model: model, skill: skill)
                    } label: {
                        SkillSummaryRow(skill: skill)
                            .contentShape(Rectangle())
                    }
                }
            }

            Section("User Skills used by this checkout") {
                if section.inheritedUserSkills.isEmpty {
                    Text("No User Skills are used by this checkout.").foregroundStyle(.secondary)
                }
                ForEach(section.inheritedUserSkills) { skill in
                    NavigationLink {
                        SkillDetailView(model: model, skill: skill)
                    } label: {
                        SkillSummaryRow(skill: skill, inherited: true)
                            .contentShape(Rectangle())
                    }
                }
            }
        }
        .navigationTitle(checkoutKind)
        .confirmationDialog("Stop tracking this checkout?", isPresented: $confirmsStopTracking) {
            Button("Stop tracking", role: .destructive) {
                Task { await model.stopTrackingProject(section.project.root) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Caddie will forget \(section.project.root). The folder, Git worktree, Skills, and project files will stay unchanged.")
        }
    }

    private var checkoutKind: String {
        switch section.project.checkoutKind {
        case "main": return "Main"
        case "worktree": return "Worktree"
        default: return "Project"
        }
    }

    private var reviewMessage: String {
        switch section.project.issueCode {
        case "legacy-project-scope":
            return "This checkout has an older Caddie record. Caddie can repair it after every owned Skill matches."
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
}

private struct SourceSummaryRow: View {
    let source: SkillInventoryPresentation.SourceSection

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: source.type == "git" ? "network" : source.type == "unmanaged" ? "questionmark.folder" : "folder")
                .font(.title3).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(source.name).fontWeight(.semibold)
                Text(source.location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text("\(source.skills.count) skills").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 7)
    }
}

private struct SourceDetailView: View {
    @ObservedObject var model: AppModel
    let source: SkillInventoryPresentation.SourceSection

    var body: some View {
        List {
            Section("Source") {
                DetailValue(label: "Type", value: source.type.capitalized)
                DetailValue(label: source.type == "git" ? "Git URL" : "Folder", value: source.location)
            }
            Section("Skills") {
                ForEach(source.skills) { skill in
                    NavigationLink {
                        SkillDetailView(model: model, skill: skill)
                    } label: {
                        SkillSummaryRow(skill: skill)
                            .contentShape(Rectangle())
                    }
                }
            }
        }
        .navigationTitle(source.name)
    }
}

struct SkillSummaryRow: View {
    let skill: AppSnapshot.InventorySkill
    var inherited = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: skill.scope == "project" ? "folder.badge.gearshape" : "wrench.and.screwdriver")
                .font(.title3).foregroundStyle(statusColor)
            VStack(alignment: .leading, spacing: 4) {
                Text(skill.name).fontWeight(.medium)
                Text(originLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if skill.shadowsSkillId != nil {
                Text("Override").font(.caption).foregroundStyle(.blue)
            }
            if inherited {
                Text("User").font(.caption).foregroundStyle(.secondary)
            }
            Text(statusLabel).font(.caption).foregroundStyle(statusColor)
        }
        .padding(.vertical, 6)
    }

    private var originLabel: String {
        if skill.permissionFolder != nil { return "Access needed" }
        return skill.origin?.name ?? "Unmanaged"
    }

    private var statusLabel: String {
        switch skill.status {
        case "manual-only": return "Manual"
        case "unmanaged": return "Unmanaged"
        case "attention": return "Needs review"
        default: return skill.status.capitalized
        }
    }

    private var statusColor: Color {
        skill.status == "attention" ? .orange : skill.status == "ready" ? .blue : .secondary
    }
}

struct SkillDetailView: View {
    @ObservedObject var model: AppModel
    let skill: AppSnapshot.InventorySkill

    var body: some View {
        List {
            Section("Skill") {
                DetailValue(label: "Status", value: statusLabel)
                DetailValue(label: "Scope", value: skill.scope == "project" ? "Project Skill" : "User Skill")
                DetailValue(label: "Installed folder", value: skill.installedPath)
                if let origin = skill.origin {
                    DetailValue(label: "Source", value: origin.name)
                    DetailValue(label: origin.type == "git" ? "Git URL" : "Source folder", value: origin.location)
                    DetailValue(label: "Selected path", value: origin.selectedPath)
                } else {
                    DetailValue(label: "Managed", value: "No")
                }
            }

            if !attentionItems.isEmpty || folderAccessPath != nil {
                Section("Needs review") {
                    ForEach(attentionItems) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(item.code, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                            Text(item.condition).foregroundStyle(.secondary)
                            CaddieAttentionActions(model: model, item: item, allowHandoff: model.canHandoff(item))
                        }
                        .padding(.vertical, 4)
                    }
                    if let folderAccessPath {
                        Button("Grant Access") { model.grantAccess(to: folderAccessPath) }
                    }
                }
            }

            Section("Updates") {
                if skill.scope == "user", skill.managed, let selectionID = skill.selectionId {
                    Toggle("Automatic updates", isOn: Binding(
                        get: { model.snapshot.isAuthorized(selectionID) },
                        set: { enabled in Task { await model.setAuthorization(selectionID: selectionID, enabled: enabled) } }
                    ))
                } else if skill.scope == "project", skill.managed {
                    LabeledContent("Updates", value: "Manual")
                } else {
                    Text("Caddie does not manage this Skill.").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(skill.name)
    }

    private var statusLabel: String {
        switch skill.status {
        case "manual-only": return "Manual"
        case "unmanaged": return "Unmanaged"
        case "attention": return "Needs review"
        default: return skill.status.capitalized
        }
    }

    private var attentionItems: [AppSnapshot.Attention] {
        model.snapshot.attention.filter { item in
            item.subjectId == skill.selectionId || item.subjectId == skill.origin?.sourceId
        }
    }

    private var folderAccessPath: String? {
        if let permissionFolder = skill.permissionFolder { return permissionFolder }
        if attentionItems.contains(where: {
            $0.code.contains("permission") || $0.code.contains("unavailable") || $0.code.contains("missing-source")
        }) { return skill.origin?.localFolder }
        return nil
    }
}

struct DetailValue: View {
    let label: String
    let value: String

    var body: some View {
        LabeledContent(label) {
            Text(value).textSelection(.enabled).multilineTextAlignment(.trailing)
        }
    }
}

struct CaddieAttentionActions: View {
    @ObservedObject var model: AppModel
    let item: AppSnapshot.Attention
    let allowHandoff: Bool

    var body: some View {
        HStack {
            Button("Retry") { Task { await model.retry(attentionID: item.id) } }
            Button(model.isMuted(item) ? "Unmute" : "Mute") {
                if model.isMuted(item) { model.unmute(item) } else { model.mute(item) }
            }
            if allowHandoff {
                Menu("Open in Agent") {
                    Button("\(model.lastAgentProvider.displayName) (Last used)") {
                        Task { await model.handoff(attentionID: item.id, provider: model.lastAgentProvider) }
                    }
                    let other: AgentProvider = model.lastAgentProvider == .codex ? .claude : .codex
                    Button(other.displayName) {
                        Task { await model.handoff(attentionID: item.id, provider: other) }
                    }
                }
            }
        }
    }
}

private struct EmptyInventoryView: View {
    let title: String
    let message: String
    let symbol: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .multilineTextAlignment(.center)
    }
}
