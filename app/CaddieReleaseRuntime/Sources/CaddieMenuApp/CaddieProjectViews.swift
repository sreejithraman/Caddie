import CaddieMacAppCore
import SwiftUI

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
