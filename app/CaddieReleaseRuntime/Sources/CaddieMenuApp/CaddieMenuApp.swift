import AppKit
import CaddieMacAppCore
import ServiceManagement
import SwiftUI

@main
struct CaddieMenuApp: App {
    @StateObject private var model: AppModel

    init() {
        let model = AppModel(client: ToolLaunchClient())
        _model = StateObject(wrappedValue: model)
        Task { @MainActor in model.start() }
    }

    var body: some Scene {
        MenuBarExtra("Caddie", systemImage: menuSymbol) {
            CaddieMenu(model: model)
        }
        .menuBarExtraStyle(.window)
    }

    private var menuSymbol: String {
        if model.snapshot.summary.attention > 0 { return "exclamationmark.circle.fill" }
        if model.isRunningCycle { return "arrow.triangle.2.circlepath" }
        return "wrench.and.screwdriver"
    }
}

private struct CaddieMenu: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.menuSnapshot.recovery != nil || model.menuSnapshot.pause.active || toolAttention.count > 0 { urgentSection }
                    sourcesSection
                    projectSection
                    readyWorkSection
                    activitySection
                }
                .padding(14)
            }
            Divider()
            controls
        }
        .frame(width: 420, height: 600)
        .alert("Caddie needs help", isPresented: Binding(
            get: { model.lastError != nil }, set: { if !$0 { model.clearError() } }
        )) { Button("OK") { model.clearError() } } message: { Text(model.lastError ?? "") }
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
                if model.menuSnapshot.pause.active {
                    Label("Safety pause: \(model.menuSnapshot.pause.reason ?? "updates need review")", systemImage: "pause.circle.fill")
                    Text("Resume checks that the safety issue is gone before automatic updates restart.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(toolAttention) { item in Label(item.code, systemImage: "exclamationmark.triangle.fill") }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sources").font(.headline)
            if model.menuSnapshot.sources.isEmpty { Text("No User Skill sources yet").foregroundStyle(.secondary) }
            ForEach(model.menuSnapshot.sources) { source in SourceCard(model: model, source: source) }
        }
    }

    @ViewBuilder private var projectSection: some View {
        if !model.menuSnapshot.projectSkills.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Project Skills").font(.headline)
                ForEach(model.menuSnapshot.projectSkills) { skill in
                    HStack { Text(skill.name ?? skill.selectedPath ?? skill.id); Spacer(); Text(skill.status).foregroundStyle(.secondary) }
                }
            }
        }
    }

    @ViewBuilder private var readyWorkSection: some View {
        if !model.menuSnapshot.readyWork.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ready Work").font(.headline)
                ForEach(model.menuSnapshot.readyWork) { work in
                    Label(work.selectionId, systemImage: "arrow.down.circle")
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
            Divider()
            HStack {
                Button("About Caddie") { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
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

private struct SourceCard: View {
    @ObservedObject var model: AppModel
    let source: AppSnapshot.Source
    @State private var expanded = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 7) {
                Button { expanded.toggle() } label: {
                    HStack {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        VStack(alignment: .leading) {
                            Text(source.id).fontWeight(.semibold)
                            Text(source.checkout ?? "Source path unavailable").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(model.isRunningCycle ? "updating" : source.state).foregroundStyle(statusColor)
                    }
                }.buttonStyle(.plain)
                HStack {
                    Text(source.branch ?? "No branch")
                    Text("\(source.skillCount) skills")
                    Text(source.automaticUpdates ? "Auto" : "Manual")
                    if source.attentionCount > 0 { Text("\(source.attentionCount) attention") }
                }.font(.caption).foregroundStyle(.secondary)
                if let highestAttention {
                    Label(highestAttention.code, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.orange)
                } else if source.nextAction != "none" {
                    Text(source.nextAction == "review-ready-work" ? "Ready to review" : source.nextAction)
                        .font(.caption).foregroundStyle(.blue)
                }
                if expanded {
                    ForEach(model.menuSnapshot.skills(for: source.id)) { skill in
                        HStack { Text(skill.name ?? skill.selectedPath); Spacer(); Text(skill.status).foregroundStyle(.secondary) }
                    }
                    ForEach(model.menuSnapshot.attention(for: source.id)) { item in
                        Label(item.code, systemImage: "exclamationmark.triangle")
                    }
                    ForEach(readyWork) { work in
                        Label("Ready: \(work.kind)", systemImage: "arrow.down.circle")
                    }
                    ForEach(sourceActivity.prefix(3)) { item in
                        Label(item.kind, systemImage: "clock.arrow.circlepath")
                            .foregroundStyle(.secondary)
                    }
                    if needsFolderAccess, let checkout = source.checkout {
                        Button("Grant Access") { model.grantAccess(to: checkout) }
                    }
                }
            }
        }
    }

    private var statusColor: Color {
        source.state == "attention" ? .orange : source.state == "ready" ? .blue : .secondary
    }

    private var needsFolderAccess: Bool {
        model.menuSnapshot.attention(for: source.id).contains {
            $0.code.contains("permission") || $0.code.contains("unavailable") || $0.code.contains("missing-source")
        }
    }

    private var readyWork: [AppSnapshot.ReadyWork] {
        let skillIDs = Set(model.menuSnapshot.skills(for: source.id).map(\.id))
        return model.menuSnapshot.readyWork.filter { skillIDs.contains($0.selectionId) }
    }

    private var highestAttention: AppSnapshot.Attention? {
        let rank = ["critical": 0, "high": 1, "normal": 2, "low": 3]
        return model.menuSnapshot.attention(for: source.id).min {
            rank[$0.priority, default: 4] < rank[$1.priority, default: 4]
        }
    }

    private var sourceActivity: [AppSnapshot.Activity] {
        let skillIDs = Set(model.menuSnapshot.skills(for: source.id).map(\.id))
        return model.menuSnapshot.activity.filter { $0.subjectId == source.id || skillIDs.contains($0.subjectId) }
    }
}
