import AppKit
import CaddieMacAppCore
import ServiceManagement
import SwiftUI

struct CaddieMainWindow: View {
    @ObservedObject var model: AppModel
    @State private var page = CaddiePage.overview
    @State private var showsError = false

    var body: some View {
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
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            if let message = model.lastError {
                ToolbarItem {
                    Button {
                        showsError.toggle()
                    } label: {
                        Label("Caddie needs help", systemImage: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(.orange)
                    .popover(isPresented: $showsError) {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("Caddie needs help", systemImage: "exclamationmark.triangle.fill")
                                .font(.headline)
                                .foregroundStyle(.orange)
                            Text(message)
                            Button("Dismiss") {
                                model.clearError()
                                showsError = false
                            }
                        }
                        .padding()
                        .frame(width: 320, alignment: .leading)
                    }
                }
            }
            ToolbarItem {
                if model.isRunningCycle {
                    ProgressView().controlSize(.small).help("Checking skills")
                } else {
                    Button("Sync now", systemImage: "arrow.clockwise") { model.syncNow() }
                        .help("Sync now")
                }
            }
        }
        .caddieHidesToolbarTitle()
        .onChange(of: model.lastError) { error in
            if error == nil { showsError = false }
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
            SourcesPage(
                model: model,
                sources: presentation.sources,
                unmanagedUserSkills: presentation.unmanagedUserSkills,
                isAvailable: presentation.isAvailable
            )
        case .settings:
            CaddieSettings(model: model)
        }
    }

}

private extension View {
    @ViewBuilder
    func caddieHidesToolbarTitle() -> some View {
        if #available(macOS 15.0, *) {
            toolbar(removing: .title)
        } else {
            self
        }
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
        List {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(status.overviewTitle).font(.headline)
                        Text(status.overviewMessage).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: status.symbol).foregroundStyle(status.color)
                }
                LabeledContent("Last check", value: caddieCheckedAtLabel(model.snapshot.freshness.checkedAt))
                if model.updatesPaused {
                    Button("Resume automatic updates") {
                        Task { await model.toggleAutomaticUpdates() }
                    }
                }
            } footer: {
                Text("User Skills can apply across projects. Project Skills stay with one project.")
            }

            if let recovery = model.snapshot.recovery {
                Section("Recovery") {
                    Label(recovery.status, systemImage: "cross.case.fill")
                    ForEach(recoveryActions) { action in
                        Button(action.intent.type == "finish-recovery" ? "Finish" : "Roll back") {
                            Task { await model.invoke(actionID: action.id, extendedTimeout: true) }
                        }
                    }
                }
            }

            if model.snapshot.pause.active {
                Section {
                    Text(model.snapshot.pause.reason ?? "Updates need review.")
                } header: {
                    Text("Why updates are paused")
                } footer: {
                    Text("Resume checks that the issue is gone before automatic updates start again.")
                }
            }

            if !toolAttention.isEmpty {
                Section("Caddie needs review") {
                    ForEach(toolAttention) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(item.code, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                            Text(item.condition).foregroundStyle(.secondary)
                            CaddieAttentionActions(model: model, item: item, allowHandoff: false)
                        }
                    }
                }
            }

            Section("At a glance") {
                LabeledContent("Items to review", value: "\(presentation.reviewCount)")
                LabeledContent("Updates available", value: "\(model.snapshot.readyWork.count)")
                LabeledContent("User Skills", value: "\(presentation.userSkills.count)")
                LabeledContent("Projects", value: "\(presentation.projectGroups.count)")
            }

            if !projectReviewGroups.isEmpty {
                Section("Projects to review") {
                    ForEach(projectReviewGroups) { group in
                        NavigationLink {
                            ProjectDetailView(model: model, groupID: group.id)
                        } label: {
                            ProjectSummaryRow(group: group)
                        }
                    }
                    Button("View all Projects") { selectPage(.projects) }
                }
            }

            if !userReviewSkills.isEmpty {
                Section("User Skills to review") {
                    ForEach(userReviewSkills.prefix(5)) { skill in
                        NavigationLink {
                            SkillDetailView(model: model, skillID: skill.id)
                        } label: {
                            SkillSummaryRow(skill: skill)
                        }
                    }
                    Button("View all User Skills") { selectPage(.userSkills) }
                }
            }

            if !presentation.readySkills.isEmpty {
                Section("Updates available") {
                    ForEach(presentation.readySkills.prefix(5)) { item in
                        LabeledContent {
                            Button("Update") { Task { await model.update(selectionID: item.work.selectionId) } }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(item.name, systemImage: "arrow.down.circle")
                                if let source = item.sourceName {
                                    Text("From \(source)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Button("Review updates in User Skills") { selectPage(.userSkills) }
                }
            }

            if !presentation.recentActivity.isEmpty {
                Section("Recent activity") {
                    ForEach(presentation.recentActivity.prefix(5)) { item in
                        LabeledContent(item.title, value: item.subject)
                    }
                }
            }
        }
        .navigationTitle("Overview")
    }

    private var projectReviewGroups: [SkillInventoryPresentation.ProjectGroup] {
        presentation.projectGroups.filter(\.needsReview)
    }

    private var userReviewSkills: [AppSnapshot.InventorySkill] {
        presentation.userSkills.filter { $0.status == "attention" }
    }

    private var toolAttention: [AppSnapshot.Attention] {
        model.snapshot.attention.filter { $0.subjectId == "tool" || $0.subjectId == "recovery" }
    }

    private var recoveryActions: [AppSnapshot.PendingAction] {
        model.snapshot.pendingActions.filter { ["finish-recovery", "rollback-recovery"].contains($0.intent.type) }
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
