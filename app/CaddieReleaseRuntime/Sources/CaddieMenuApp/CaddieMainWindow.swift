import AppKit
import CaddieMacAppCore
import ServiceManagement
import SwiftUI

struct CaddieMainWindow: View {
    @ObservedObject var model: AppModel
    @State private var page = CaddiePage.overview

    var body: some View {
        VStack(spacing: 0) {
            if let message = model.lastError {
                InlineFaultNotice(message: message, dismiss: model.clearError)
                    .padding(12)
                Divider()
            }
            NavigationSplitView {
                List(selection: $page) {
                    ForEach(CaddiePage.allCases) { item in
                        Label(item.rawValue, systemImage: item.symbol)
                            .tag(item)
                    }
                }
                .navigationTitle("Caddie")
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
            } detail: {
                NavigationStack {
                    pageContent
                }
                .id(page)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if model.isRunningCycle { ProgressView().controlSize(.small) }
                Text(lastChecked).font(.caption).foregroundStyle(.secondary)
                Button("Sync now") { model.syncNow() }
                    .disabled(model.isRunningCycle)
            }
        }
        .frame(minWidth: 780, minHeight: 520)
    }

    @ViewBuilder private var pageContent: some View {
        let presentation = model.inventoryPresentation
        switch page {
        case .overview:
            CaddieOverview(model: model, presentation: presentation, selectPage: { page = $0 })
        case .userSkills:
            UserSkillsPage(model: model, skills: presentation.userSkills, isAvailable: presentation.isAvailable)
        case .projects:
            ProjectsPage(model: model, groups: presentation.projectGroups, isAvailable: presentation.isAvailable)
        case .sources:
            SourcesPage(model: model, sources: presentation.sources, isAvailable: presentation.isAvailable)
        case .settings:
            CaddieSettings(model: model)
        }
    }

    private var lastChecked: String {
        guard let checked = model.snapshot.freshness.checkedAt else { return "Waiting for first check" }
        return "Last checked \(checked)"
    }
}

private enum CaddiePage: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case userSkills = "User Skills"
    case projects = "Projects"
    case sources = "Sources"
    case settings = "Settings"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .userSkills: return "person.crop.circle"
        case .projects: return "folder"
        case .sources: return "externaldrive.connected.to.line.below"
        case .settings: return "gearshape"
        }
    }
}

private struct CaddieOverview: View {
    @ObservedObject var model: AppModel
    let presentation: SkillInventoryPresentation
    let selectPage: (CaddiePage) -> Void

    var body: some View {
        let status = CaddieAppStatusPresentation(CaddieAppStatus(
            snapshot: model.snapshot,
            isRunningCycle: model.isRunningCycle,
            updatesPaused: model.updatesPaused
        ))
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(status.overviewTitle).font(.largeTitle).fontWeight(.semibold)
                    Text(status.overviewMessage).foregroundStyle(.secondary)
                }

                if let recovery = model.snapshot.recovery {
                    GroupBox("Recovery") {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(recovery.status, systemImage: "cross.case.fill")
                            HStack {
                                ForEach(recoveryActions) { action in
                                    Button(action.intent.type == "finish-recovery" ? "Finish" : "Roll back") {
                                        Task { await model.invoke(actionID: action.id, extendedTimeout: true) }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if model.snapshot.pause.active {
                    GroupBox("Updates paused") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.snapshot.pause.reason ?? "Updates need review.")
                            Text("Resume checks that the issue is gone before automatic updates start again.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Resume updates") { Task { await model.toggleAutomaticUpdates() } }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if !toolAttention.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Tool needs review").font(.title2).fontWeight(.semibold)
                        ForEach(toolAttention) { item in
                            GroupBox {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(item.condition).foregroundStyle(.secondary)
                                    CaddieAttentionActions(model: model, item: item, allowHandoff: false)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            } label: {
                                Label(item.code, systemImage: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                }

                HStack(spacing: 12) {
                    SummaryButton(
                        title: "Needs review", value: presentation.reviewCount,
                        symbol: "exclamationmark.triangle", color: presentation.needsReview ? .orange : .secondary
                    )
                    SummaryButton(
                        title: "Ready work", value: model.snapshot.readyWork.count,
                        symbol: "arrow.down.circle", color: .blue
                    )
                    SummaryButton(
                        title: "User skills", value: presentation.userSkills.count,
                        symbol: "person.crop.circle", color: .accentColor,
                        action: { selectPage(.userSkills) }
                    )
                    SummaryButton(
                        title: "Projects", value: presentation.projectGroups.count,
                        symbol: "folder", color: .accentColor,
                        action: { selectPage(.projects) }
                    )
                }

                if !projectReviewGroups.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Projects to review").font(.title2).fontWeight(.semibold)
                            Spacer()
                            Button("View all") { selectPage(.projects) }
                        }
                        ForEach(projectReviewGroups) { group in
                            NavigationLink {
                                ProjectDetailView(model: model, groupID: group.id)
                            } label: {
                                ProjectSummaryRow(group: group)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !model.snapshot.readyWork.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Ready work").font(.title2).fontWeight(.semibold)
                        ForEach(model.snapshot.readyWork) { work in
                            HStack {
                                Label(work.selectionId, systemImage: "arrow.down.circle")
                                Spacer()
                                Button("Update") { Task { await model.update(selectionID: work.selectionId) } }
                            }
                            .padding(12)
                            .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }

                if !model.snapshot.activity.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Recent activity").font(.title2).fontWeight(.semibold)
                        ForEach(model.snapshot.activity.prefix(8)) { item in
                            HStack {
                                Text(item.kind)
                                Spacer()
                                Text(item.subjectId).foregroundStyle(.secondary)
                            }
                            .font(.callout)
                        }
                    }
                }
            }
            .padding(28)
            .frame(maxWidth: 1_050, alignment: .leading)
        }
        .navigationTitle("Overview")
    }

    private var projectReviewGroups: [SkillInventoryPresentation.ProjectGroup] {
        presentation.projectGroups.filter(\.needsReview)
    }

    private var toolAttention: [AppSnapshot.Attention] {
        model.snapshot.attention.filter { $0.subjectId == "tool" || $0.subjectId == "recovery" }
    }

    private var recoveryActions: [AppSnapshot.PendingAction] {
        model.snapshot.pendingActions.filter { ["finish-recovery", "rollback-recovery"].contains($0.intent.type) }
    }

}

private struct SummaryButton: View {
    let title: String
    let value: Int
    let symbol: String
    let color: Color
    var action: (() -> Void)?

    var body: some View {
        Group {
            if let action {
                Button(action: action) { content.contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            } else {
                content
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(color)
            Text("\(value)").font(.title).fontWeight(.semibold)
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct CaddieSettings: View {
    @ObservedObject var model: AppModel
    @State private var confirmsRemoval = false

    var body: some View {
        Form {
            Section("Updates") {
                LabeledContent("Automatic updates") {
                    Button(model.updatesPaused ? "Resume" : "Pause") {
                        Task { await model.toggleAutomaticUpdates() }
                    }
                }
                if model.automaticUpdatesPaused {
                    Text("Automatic updates are paused on this Mac.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Mac") {
                Toggle("Start at login", isOn: Binding(
                    get: { model.loginItemStatus == .enabled },
                    set: { model.setStartAtLogin($0) }
                ))
                .disabled(model.snapshot.state != "ready")

                if model.loginItemStatus == .requiresApproval {
                    Button("Open Login Items settings") { model.openLoginItemSettings() }
                }

                Toggle("Notifications", isOn: Binding(
                    get: { model.notificationsEnabled },
                    set: { enabled in Task { await model.setNotificationsEnabled(enabled) } }
                ))
            }

            Section("Caddie") {
                Button("About Caddie") { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
                Button("Remove Caddie…", role: .destructive) { confirmsRemoval = true }
            }
        }
        .formStyle(.grouped)
        .padding()
        .navigationTitle("Settings")
        .confirmationDialog("Prepare to remove Caddie?", isPresented: $confirmsRemoval) {
            Button("Turn off login and quit", role: .destructive) {
                if model.prepareForAppRemoval() { NSApplication.shared.terminate(nil) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your Caddie Skill, Tool fallback, managed skills, and user and project state stay in place. You can then remove Caddie with Homebrew or move the app to Trash.")
        }
    }
}
