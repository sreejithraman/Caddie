import AppKit
import CaddieMacAppCore
import SwiftUI

struct CaddieStatusMenu: View {
    @ObservedObject var model: AppModel
    let openCaddie: () -> Void

    var body: some View {
        let status = CaddieAppStatusPresentation(CaddieAppStatus(
            snapshot: model.snapshot,
            isRunningCycle: model.isRunningCycle,
            updatesPaused: model.updatesPaused
        ))
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: status.symbol)
                        .font(.title2)
                        .foregroundStyle(status.color)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(status.title).font(.headline)
                        Text(status.message).font(.caption).foregroundStyle(.secondary)
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

    private var lastChecked: String {
        caddieCheckedAtLabel(model.snapshot.freshness.checkedAt)
    }
}

func caddieCheckedAtLabel(_ checkedAt: String?, now: Date = Date()) -> String {
    guard let checkedAt else { return "Waiting for first check" }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: checkedAt) ?? ISO8601DateFormatter().date(from: checkedAt)
    guard let date else { return "Last check complete" }
    let relative = RelativeDateTimeFormatter()
    relative.unitsStyle = .full
    return "Checked \(relative.localizedString(for: date, relativeTo: now))"
}

struct CaddieAppStatusPresentation {
    let title: String
    let message: String
    let symbol: String
    let menuBarSymbol: String
    let overviewTitle: String
    let overviewMessage: String
    let color: Color

    init(_ status: CaddieAppStatus) {
        switch status {
        case .checking:
            title = "Checking skills"
            message = "Caddie is checking your skills and projects."
            symbol = "arrow.triangle.2.circlepath"
            menuBarSymbol = symbol
            overviewTitle = "Checking your skills"
            overviewMessage = "This view will update when the check finishes."
            color = .green
        case .paused:
            title = "Updates paused"
            message = "Automatic updates will not run until you resume them."
            symbol = "pause.circle.fill"
            menuBarSymbol = "pause.circle"
            overviewTitle = "Updates are paused"
            overviewMessage = message
            color = .orange
        case .waiting:
            title = "Waiting for first check"
            message = "Caddie has not checked your skills yet."
            symbol = "clock"
            menuBarSymbol = "wrench.and.screwdriver"
            overviewTitle = title
            overviewMessage = "Use Sync now if the first check does not start."
            color = .secondary
        case .needsReview:
            title = "Needs review"
            message = "Open Caddie to see what needs your help."
            symbol = "exclamationmark.triangle.fill"
            menuBarSymbol = "exclamationmark.circle.fill"
            overviewTitle = "Caddie needs your help"
            overviewMessage = "Review the items below before Caddie changes anything."
            color = .orange
        case .updatesReady:
            title = "Updates ready"
            message = "Caddie found skill updates you can review."
            symbol = "arrow.down.circle.fill"
            menuBarSymbol = symbol
            overviewTitle = "Updates are ready"
            overviewMessage = "Review the updates below when you are ready."
            color = .blue
        case .current:
            title = "All good"
            message = "Your checked skills and projects are current."
            symbol = "checkmark.circle.fill"
            menuBarSymbol = "wrench.and.screwdriver"
            overviewTitle = "Everything looks good"
            overviewMessage = "Your checked User Skills and Project Skills are current."
            color = .green
        }
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
