import AppKit
import CaddieMacAppCore
import SwiftUI

struct CaddieStatusMenu: View {
    @ObservedObject var model: AppModel
    let openCaddie: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: statusSymbol)
                        .font(.title2)
                        .foregroundStyle(statusColor)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(statusTitle).font(.headline)
                        Text(statusMessage).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isRunningCycle { ProgressView().controlSize(.small) }
                }

                if let message = model.lastError {
                    InlineFaultNotice(message: message, dismiss: model.clearError)
                }

                Button(action: openCaddie) {
                    Label("Open Caddie", systemImage: "macwindow")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .keyboardShortcut("o")

                HStack {
                    Button("Sync now") { model.syncNow() }
                        .disabled(model.isRunningCycle)
                    Spacer()
                    Button(model.updatesPaused ? "Resume updates" : "Pause updates") {
                        Task { await model.toggleAutomaticUpdates() }
                    }
                }
            }
            .padding(16)

            Divider()

            HStack {
                Text(lastChecked).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .padding(12)
        }
        .frame(width: 330)
    }

    private var statusTitle: String {
        if model.isRunningCycle { return "Checking skills" }
        if model.updatesPaused { return "Updates paused" }
        if needsReview { return "Needs review" }
        if !model.snapshot.readyWork.isEmpty { return "Updates ready" }
        return "All good"
    }

    private var statusMessage: String {
        if model.isRunningCycle { return "Caddie is checking your skills and projects." }
        if model.updatesPaused { return "Automatic updates will not run until you resume them." }
        if needsReview { return "Open Caddie to see what needs your help." }
        if !model.snapshot.readyWork.isEmpty { return "Caddie found skill updates you can review." }
        return "Your checked skills and projects are current."
    }

    private var statusSymbol: String {
        if model.isRunningCycle { return "arrow.triangle.2.circlepath" }
        if model.updatesPaused { return "pause.circle.fill" }
        if needsReview { return "exclamationmark.triangle.fill" }
        if !model.snapshot.readyWork.isEmpty { return "arrow.down.circle.fill" }
        return "checkmark.circle.fill"
    }

    private var statusColor: Color {
        if model.updatesPaused || needsReview { return .orange }
        if !model.snapshot.readyWork.isEmpty { return .blue }
        return .green
    }

    private var needsReview: Bool {
        SkillInventoryPresentation(snapshot: model.snapshot).needsReview
    }

    private var lastChecked: String {
        guard let checked = model.snapshot.freshness.checkedAt else { return "Waiting for first check" }
        return "Last checked \(checked)"
    }
}

struct InlineFaultNotice: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Caddie needs help").fontWeight(.semibold)
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: dismiss) {
                Image(systemName: "xmark").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}
