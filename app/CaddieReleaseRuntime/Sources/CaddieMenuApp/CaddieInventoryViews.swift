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
                Section {
                    ForEach(filteredSkills) { skill in
                        NavigationLink {
                            SkillDetailView(model: model, skillID: skill.id)
                        } label: {
                            SkillSummaryRow(skill: skill)
                        }
                    }
                } header: {
                    Text("Skills installed for your account")
                } footer: {
                    Text("Enabled User Skills are available in each project unless a Project Skill takes their place.")
                }
            }
        }
        .searchable(text: $query, prompt: "Search User Skills")
        .navigationTitle("User Skills")
    }

    private var filteredSkills: [AppSnapshot.InventorySkill] {
        guard !query.isEmpty else { return skills }
        return skills.filter { $0.matches(query) }
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
                Section {
                    ForEach(filteredGroups) { group in
                        NavigationLink {
                            ProjectDetailView(model: model, groupID: group.id)
                        } label: {
                            ProjectSummaryRow(group: group)
                        }
                    }
                } header: {
                    Text("Skills by project")
                } footer: {
                    Text("Open a project to see its main checkout and worktrees, then see which Skills each one uses.")
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
    let unmanagedUserSkills: [AppSnapshot.InventorySkill]
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
            } else if filteredSources.isEmpty && filteredUnmanagedUserSkills.isEmpty {
                EmptyInventoryView(
                    title: query.isEmpty ? "No Sources" : "No matching Sources",
                    message: query.isEmpty ? "Caddie did not find any skill sources." : "Try a different search.",
                    symbol: "magnifyingglass"
                )
            } else {
                Section {
                    ForEach(filteredSources) { source in
                        NavigationLink {
                            SourceDetailView(model: model, sourceID: source.id)
                        } label: {
                            SourceSummaryRow(source: source)
                        }
                    }
                } header: {
                    Text("Where Skills come from")
                } footer: {
                    Text("A source is a Git repository or folder. Its checkouts can supply Skills to User Skills and projects.")
                }
                if !filteredUnmanagedUserSkills.isEmpty {
                    Section {
                        NavigationLink {
                            UnmanagedUserSkillsView(model: model, skills: filteredUnmanagedUserSkills)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("No source record").fontWeight(.semibold)
                                    Text("User Skills that Caddie did not install")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "questionmark.folder").foregroundStyle(.secondary)
                            }
                        }
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
                || $0.locations.contains { $0.localizedCaseInsensitiveContains(query) }
                || $0.uses.contains {
                    $0.skillName.localizedCaseInsensitiveContains(query)
                        || $0.targetName.localizedCaseInsensitiveContains(query)
                        || $0.targetPath?.localizedCaseInsensitiveContains(query) == true
                }
        }
    }

    private var filteredUnmanagedUserSkills: [AppSnapshot.InventorySkill] {
        guard !query.isEmpty else { return unmanagedUserSkills }
        return unmanagedUserSkills.filter { $0.matches(query) }
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
                Text(gitSummary).font(.caption2).foregroundStyle(.tertiary)
                if let folder = group.checkouts.first?.project.root {
                    Text(folder).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
            Spacer()
            if group.needsReview {
                Label("Skill review needed", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text("Skills OK").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var summary: String {
        let count = group.checkouts.reduce(0) { $0 + $1.projectSkills.count }
        return "\(group.checkouts.count) \(group.checkouts.count == 1 ? "checkout" : "checkouts") · \(count) Project Skills"
    }

    private var gitSummary: String {
        if group.checkouts.contains(where: { $0.project.workingTreeClean == false }) { return "Git: Has changes" }
        if group.checkouts.contains(where: { $0.project.upstreamState == "gone" }) { return "Git: Upstream gone" }
        if group.checkouts.contains(where: { $0.project.lifecycle == "likely-finished" }) { return "Git: May be finished" }
        if group.checkouts.allSatisfy({ $0.project.workingTreeClean == true }) { return "Git: Clean" }
        return "Git status unavailable"
    }
}

struct ProjectDetailView: View {
    @ObservedObject var model: AppModel
    let groupID: String

    var body: some View {
        let group = model.inventoryPresentation.projectGroups.first { $0.id == groupID }
        Group {
            if let group {
                List {
                    Section {
                        ForEach(group.checkouts) { checkout in
                            NavigationLink {
                                CheckoutDetailView(model: model, projectID: checkout.project.id)
                            } label: {
                                CheckoutSummaryRow(section: checkout)
                            }
                        }
                    } header: {
                        Text("\(group.checkouts.count) \(group.checkouts.count == 1 ? "checkout" : "checkouts")")
                    } footer: {
                        Text("The main checkout and its worktrees belong to the same Git repository.")
                    }
                }
            } else {
                MissingInventoryItem(title: "Project no longer found")
            }
        }
        .navigationTitle(group?.name ?? "Project")
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

private struct CheckoutDetailView: View {
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

private struct SourceSummaryRow: View {
    let source: SkillInventoryPresentation.SourceSection

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: source.type == "git" ? "network" : "folder")
                .font(.title3).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(source.name).fontWeight(.semibold)
                Text(source.summaryLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(source.skillCountLabel).font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct SourceDetailView: View {
    @ObservedObject var model: AppModel
    let sourceID: String

    var body: some View {
        let source = model.inventoryPresentation.sources.first { $0.id == sourceID }
        Group {
            if let source {
                List {
                    Section("Source") {
                        DetailValue(label: "Type", value: source.kindLabel)
                        if source.type == "git" {
                            DetailValue(label: "Git URL", value: source.location)
                        } else if source.locations.count == 1 {
                            DetailValue(label: "Folder", value: source.location)
                        }
                    }
                    Section("Used by") {
                        ForEach(source.uses) { use in
                            VStack(alignment: .leading, spacing: 3) {
                                LabeledContent(use.targetName, value: use.skillName)
                                if let path = use.targetPath {
                                    Text(path)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if source.locations.count > 1 {
                        Section("Source folders") {
                            ForEach(source.locations, id: \.self) { location in
                                Text(location).textSelection(.enabled)
                            }
                        }
                    }
                    Section("Skills") {
                        ForEach(source.skills) { skill in
                            NavigationLink {
                                SkillDetailView(model: model, skillID: skill.id)
                            } label: {
                                SkillSummaryRow(skill: skill)
                                    .contentShape(Rectangle())
                            }
                        }
                    }
                }
            } else {
                MissingInventoryItem(title: "Source no longer found")
            }
        }
        .navigationTitle(source?.name ?? "Source")
    }
}

private struct UnmanagedUserSkillsView: View {
    @ObservedObject var model: AppModel
    let skills: [AppSnapshot.InventorySkill]

    var body: some View {
        List {
            Section {
                ForEach(skills) { skill in
                    NavigationLink {
                        SkillDetailView(model: model, skillID: skill.id)
                    } label: {
                        SkillSummaryRow(skill: skill)
                    }
                }
            } footer: {
                Text("These User Skills are installed, but Caddie has no source record for them.")
            }
        }
        .navigationTitle("No source record")
    }
}

struct SkillSummaryRow: View {
    let skill: AppSnapshot.InventorySkill
    var inherited = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: skill.scope == "project" ? "folder.badge.gearshape" : "wrench.and.screwdriver")
                .font(.title3).foregroundStyle(skill.statusColor)
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
            Text(skill.statusLabel).font(.caption).foregroundStyle(skill.statusColor)
        }
    }

    private var originLabel: String {
        let source = skill.origin.map { "\($0.name) · \($0.location)" }
            ?? "Local folder · \(skill.installedPath)"
        return skill.permissionFolder == nil ? source : "Access needed · \(source)"
    }
}

struct SkillDetailView: View {
    @ObservedObject var model: AppModel
    let skillID: String

    var body: some View {
        let skill = model.snapshot.inventorySkills.first { $0.id == skillID }
        Group {
            if let skill {
                skillList(skill)
            } else {
                MissingInventoryItem(title: "Skill no longer found")
            }
        }
        .navigationTitle(skill?.name ?? "Skill")
    }

    private func skillList(_ skill: AppSnapshot.InventorySkill) -> some View {
        let attentionItems = attentionItems(for: skill)
        let folderAccessPath = folderAccessPath(for: skill, attentionItems: attentionItems)
        return List {
            Section("Skill") {
                DetailValue(label: "Availability", value: skill.enabled ? "Available" : "Disabled")
                DetailValue(label: "Update status", value: skill.updateStatusLabel)
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
                            .disabled(model.isPreview)
                    }
                }
            }

            Section("Updates") {
                if skill.scope == "user", skill.managed, let selectionID = skill.selectionId {
                    Toggle("Automatic updates", isOn: Binding(
                        get: { model.snapshot.isAuthorized(selectionID) },
                        set: { enabled in Task { await model.setAuthorization(selectionID: selectionID, enabled: enabled) } }
                    ))
                    .disabled(model.isPreview)
                } else if skill.scope == "project", skill.managed {
                    LabeledContent("Update method", value: "With the project")
                    Text("Caddie checks this Skill but does not change Project Skills automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Caddie does not manage this Skill.").foregroundStyle(.secondary)
                }
            }
        }
    }

    private func attentionItems(for skill: AppSnapshot.InventorySkill) -> [AppSnapshot.Attention] {
        model.snapshot.attention.filter { item in
            item.subjectId == skill.selectionId || item.subjectId == skill.origin?.sourceId
        }
    }

    private func folderAccessPath(
        for skill: AppSnapshot.InventorySkill,
        attentionItems: [AppSnapshot.Attention]
    ) -> String? {
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
        .disabled(model.isPreview)
    }
}

private struct EmptyInventoryView: View {
    let title: String
    let message: String
    let symbol: String

    var body: some View {
        Group {
            if #available(macOS 14.0, *) {
                ContentUnavailableView(title, systemImage: symbol, description: Text(message))
            } else {
                VStack(spacing: 8) {
                    Image(systemName: symbol).font(.largeTitle).foregroundStyle(.secondary)
                    Text(title).font(.headline)
                    Text(message).foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }
}

private struct MissingInventoryItem: View {
    let title: String

    var body: some View {
        Group {
            if #available(macOS 14.0, *) {
                ContentUnavailableView(
                    title,
                    systemImage: "arrow.clockwise",
                    description: Text("Caddie refreshed while this page was open. Go back to see the current list.")
                )
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise").font(.largeTitle).foregroundStyle(.secondary)
                    Text(title).font(.headline)
                    Text("Caddie refreshed while this page was open. Go back to see the current list.")
                        .foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                .padding()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

private extension AppSnapshot.InventorySkill {
    func matches(_ query: String) -> Bool {
        name.localizedCaseInsensitiveContains(query)
            || origin?.name.localizedCaseInsensitiveContains(query) == true
            || installedPath.localizedCaseInsensitiveContains(query)
    }

    var statusColor: Color {
        if !enabled { return .secondary }
        return status == "attention" ? .orange : status == "ready" ? .blue : .secondary
    }
}
