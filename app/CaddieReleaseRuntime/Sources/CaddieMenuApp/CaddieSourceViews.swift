import CaddieMacAppCore
import SwiftUI

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
