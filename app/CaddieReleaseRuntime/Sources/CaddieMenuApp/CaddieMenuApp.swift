import AppKit
import CaddieMacAppCore
import ServiceManagement
import SwiftUI

@main
struct CaddieMenuApp: App {
    @StateObject private var model: AppModel
    private let locationMessage: String?

    init() {
        let channel = CaddieBuildChannel(bundleIdentifier: Bundle.main.bundleIdentifier)
        let supportRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(channel.applicationSupportFolder, isDirectory: true)
        let environment = channel.toolEnvironment(base: ProcessInfo.processInfo.environment, supportRoot: supportRoot)
        let toolHome = URL(fileURLWithPath: environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path)
        let model = AppModel(
            client: ToolLaunchClient(supportRoot: supportRoot, environment: environment),
            toolStateRoot: toolHome.appendingPathComponent(".agents/.caddie", isDirectory: true)
        )
        _model = StateObject(wrappedValue: model)
        let assessment = AppLocationPolicy().assess(
            bundleURL: Bundle.main.bundleURL,
            homeURL: FileManager.default.homeDirectoryForCurrentUser,
            channel: channel
        )
        if case .blocked(let reason) = assessment {
            locationMessage = reason.userMessage
        } else {
            locationMessage = nil
            Task { @MainActor in model.start() }
        }
    }

    var body: some Scene {
        MenuBarExtra("Caddie", systemImage: menuSymbol) {
            if let locationMessage {
                BlockedLocationMenu(message: locationMessage)
            } else {
                CaddieMenu(model: model)
            }
        }
        .menuBarExtraStyle(.window)
    }

    private var menuSymbol: String {
        if model.snapshot.summary.attention > 0 { return "exclamationmark.circle.fill" }
        if model.isRunningCycle { return "arrow.triangle.2.circlepath" }
        return "wrench.and.screwdriver"
    }
}

private struct BlockedLocationMenu: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Move Caddie", systemImage: "folder.badge.questionmark")
                .font(.headline)
            Text(message)
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .padding(16)
        .frame(width: 320)
    }
}

private struct CaddieMenu: View {
    @ObservedObject var model: AppModel
    @State private var confirmsRemoval = false
    @State private var inventoryView = InventoryView.skills
    @State private var userSkillsExpanded = true

    private enum InventoryView: String, CaseIterable, Identifiable {
        case skills = "Skills"
        case sources = "Sources"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let message = model.lastError {
                faultNotice(message)
                Divider()
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.menuSnapshot.recovery != nil || model.menuSnapshot.pause.active || toolAttention.count > 0 { urgentSection }
                    Picker("View", selection: $inventoryView) {
                        ForEach(InventoryView.allCases) { view in Text(view.rawValue).tag(view) }
                    }
                    .pickerStyle(.segmented)
                    if inventoryView == .skills { skillsSection } else { inventorySourcesSection }
                    readyWorkSection
                    activitySection
                }
                .padding(14)
            }
            Divider()
            controls
        }
        .frame(width: 420, height: 600)
        .confirmationDialog("Prepare to remove Caddie?", isPresented: $confirmsRemoval) {
            Button("Turn off login and quit") {
                if model.prepareForAppRemoval() { NSApplication.shared.terminate(nil) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your Caddie Skill, Tool fallback, managed skills, and user and project state stay in place. You can then remove Caddie with Homebrew or move the app to Trash.")
        }
    }

    private func faultNotice(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Caddie needs help").fontWeight(.semibold)
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { model.clearError() } label: {
                Image(systemName: "xmark").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("Caddie").font(.headline)
                Text(lastChecked).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.isRunningCycle { ProgressView().controlSize(.small) }
            Button("Sync now") { model.syncNow() }.disabled(model.isRunningCycle)
        }
        .padding(14)
    }

    private var urgentSection: some View {
        GroupBox("Needs attention") {
            VStack(alignment: .leading, spacing: 6) {
                if let recovery = model.menuSnapshot.recovery { Label(recovery.status, systemImage: "cross.case.fill") }
                ForEach(model.menuSnapshot.pendingActions.filter { ["finish-recovery", "rollback-recovery"].contains($0.intent.type) }) { action in
                    Button(action.intent.type == "finish-recovery" ? "Finish" : "Roll back") {
                        Task { await model.invoke(actionID: action.id, extendedTimeout: true) }
                    }
                }
                if model.menuSnapshot.pause.active {
                    Label("Safety pause: \(model.menuSnapshot.pause.reason ?? "updates need review")", systemImage: "pause.circle.fill")
                    Text("Resume checks that the safety issue is gone before automatic updates restart.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(toolAttention) { item in AttentionRow(model: model, item: item, allowHandoff: false) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var skillsSection: some View {
        let presentation = SkillInventoryPresentation(snapshot: model.menuSnapshot)
        return VStack(alignment: .leading, spacing: 14) {
            DisclosureGroup(isExpanded: $userSkillsExpanded) {
                VStack(alignment: .leading, spacing: 7) {
                    if presentation.userSkills.isEmpty {
                        Text("No User Skills found").foregroundStyle(.secondary)
                    }
                    ForEach(presentation.userSkills) { skill in
                        InventorySkillRow(model: model, skill: skill)
                    }
                }
                .padding(.top, 7)
            } label: {
                HStack {
                    Text("User Skills").font(.headline)
                    Spacer()
                    Text("\(presentation.userSkills.count) skills").font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(presentation.projects) { section in
                ProjectInventorySection(model: model, section: section)
            }
        }
    }

    private var inventorySourcesSection: some View {
        let presentation = SkillInventoryPresentation(snapshot: model.menuSnapshot)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Sources").font(.headline)
            if presentation.sources.isEmpty { Text("No skill sources found").foregroundStyle(.secondary) }
            ForEach(presentation.sources) { source in
                InventorySourceCard(model: model, source: source)
            }
        }
    }

    @ViewBuilder private var readyWorkSection: some View {
        if !model.menuSnapshot.readyWork.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ready Work").font(.headline)
                ForEach(model.menuSnapshot.readyWork) { work in
                    HStack {
                        Label(work.selectionId, systemImage: "arrow.down.circle")
                        Spacer()
                        Button("Update") { Task { await model.update(selectionID: work.selectionId) } }
                    }
                }
            }
        }
    }

    @ViewBuilder private var activitySection: some View {
        if !model.menuSnapshot.activity.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Recent Activity").font(.headline)
                ForEach(model.menuSnapshot.activity.prefix(5)) { item in
                    HStack { Text(item.kind); Spacer(); Text(item.subjectId).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 0) {
            if model.automaticUpdatesPaused {
                Text("Automatic updates are paused on this Mac.").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.top, 8)
            }
            Button(model.updatesPaused ? "Resume Automatic Updates" : "Pause Automatic Updates") {
                Task { await model.toggleAutomaticUpdates() }
            }.buttonStyle(.plain).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 8)
            Divider()
            Toggle("Start at login", isOn: Binding(
                get: { model.loginItemStatus == .enabled }, set: { model.setStartAtLogin($0) }
            )).disabled(model.menuSnapshot.state != "ready").padding(.horizontal, 14).padding(.vertical, 8)
            if model.loginItemStatus == .requiresApproval {
                Button("Open Login Items settings") { model.openLoginItemSettings() }.padding(.horizontal, 14)
            }
            if !model.notificationsEnabled && model.menuSnapshot.summary.attention > 0 {
                Text("Turn on silent notices to learn when blocked work changes.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.top, 6)
            }
            Toggle("Notifications", isOn: Binding(
                get: { model.notificationsEnabled },
                set: { enabled in Task { await model.setNotificationsEnabled(enabled) } }
            )).padding(.horizontal, 14).padding(.vertical, 8)
            Divider()
            HStack {
                Button("About Caddie") { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
                Button("Remove Caddie…") { confirmsRemoval = true }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }.padding(14)
        }
    }

    private var toolAttention: [AppSnapshot.Attention] {
        model.menuSnapshot.attention.filter { $0.subjectId == "tool" || $0.subjectId == "recovery" }
    }

    private var lastChecked: String {
        guard let checked = model.menuSnapshot.freshness.checkedAt else { return "Waiting for first check" }
        return "Last checked \(checked)"
    }
}

private struct ProjectInventorySection: View {
    @ObservedObject var model: AppModel
    let section: SkillInventoryPresentation.ProjectSection
    @State private var expanded = true
    @State private var inheritedExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 7) {
                if section.projectSkills.isEmpty {
                    Text("No Project Skills found").foregroundStyle(.secondary)
                }
                ForEach(section.projectSkills) { skill in
                    InventorySkillRow(model: model, skill: skill)
                }
                if !section.inheritedUserSkills.isEmpty {
                    DisclosureGroup(isExpanded: $inheritedExpanded) {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(section.inheritedUserSkills) { skill in
                                InventorySkillRow(model: model, skill: skill, inherited: true)
                            }
                        }
                        .padding(.top, 6)
                    } label: {
                        Text("Also uses \(section.inheritedUserSkills.count) User Skills")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.top, 7)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(section.project.name).font(.headline)
                    Spacer()
                    if section.project.status == "attention" {
                        Label("Attention", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if section.project.overrideCount > 0 {
                        Text("\(section.project.overrideCount) overrides")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("\(section.projectSkills.count) skills").font(.caption).foregroundStyle(.secondary)
                }
                Text(section.project.root).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

private struct InventorySkillRow: View {
    @ObservedObject var model: AppModel
    let skill: AppSnapshot.InventorySkill
    var inherited = false
    @State private var expanded = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 7) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(skill.name).fontWeight(.medium)
                            Text(originLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if skill.shadowsSkillId != nil { Text("Override").font(.caption).foregroundStyle(.blue) }
                        if inherited { Text("User").font(.caption).foregroundStyle(.secondary) }
                        Text(statusLabel).font(.caption).foregroundStyle(statusColor)
                    }
                }.buttonStyle(.plain)
                if expanded {
                    ForEach(attentionItems) { item in
                        AttentionRow(model: model, item: item, allowHandoff: model.canHandoff(item))
                    }
                    if let folder = folderAccessPath {
                        Button("Grant Access") { model.grantAccess(to: folder) }
                    }
                    detail("Installed", skill.installedPath)
                    if let origin = skill.origin {
                        detail(origin.type == "git" ? "Git" : "Folder", origin.location)
                        detail("Selected path", origin.selectedPath)
                    } else {
                        detail("Managed", "No")
                    }
                    if skill.scope == "user", skill.managed, let selectionID = skill.selectionId {
                        Toggle("Automatic updates", isOn: Binding(
                            get: { model.menuSnapshot.isAuthorized(selectionID) },
                            set: { enabled in Task { await model.setAuthorization(selectionID: selectionID, enabled: enabled) } }
                        ))
                        .font(.caption)
                    }
                }
            }
        }
    }

    private var originLabel: String {
        if let permissionFolder = skill.permissionFolder { return "Folder access needed · \(permissionFolder)" }
        guard let origin = skill.origin else { return "Unmanaged · \(skill.installedPath)" }
        return "From \(origin.name) · \(origin.location)"
    }

    private var statusLabel: String {
        switch skill.status {
        case "manual-only": return "Manual"
        case "unmanaged": return "Unmanaged"
        default: return skill.status.capitalized
        }
    }

    private var statusColor: Color {
        skill.status == "attention" ? .orange : skill.status == "ready" ? .blue : .secondary
    }

    private var attentionItems: [AppSnapshot.Attention] {
        model.menuSnapshot.attention.filter { item in
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

    private func detail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption).textSelection(.enabled)
        }
    }
}

private struct InventorySourceCard: View {
    @ObservedObject var model: AppModel
    let source: SkillInventoryPresentation.SourceSection
    @State private var expanded = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 7) {
                Button { expanded.toggle() } label: {
                    HStack {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source.name).fontWeight(.semibold)
                            Text(source.location).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text("\(source.skills.count) skills").font(.caption).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
                if expanded {
                    ForEach(source.skills) { skill in InventorySkillRow(model: model, skill: skill) }
                }
            }
        }
    }
}

private struct AttentionRow: View {
    @ObservedObject var model: AppModel
    let item: AppSnapshot.Attention
    let allowHandoff: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(item.code, systemImage: "exclamationmark.triangle")
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
                        Button(other.displayName) { Task { await model.handoff(attentionID: item.id, provider: other) } }
                    }
                }
            }.font(.caption)
        }
    }
}
