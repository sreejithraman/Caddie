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


private extension AppSnapshot.InventorySkill {
    var statusColor: Color {
        if !enabled { return .secondary }
        return status == "attention" ? .orange : status == "ready" ? .blue : .secondary
    }
}
