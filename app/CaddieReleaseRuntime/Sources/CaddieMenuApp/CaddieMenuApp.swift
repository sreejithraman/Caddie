import CaddieMacAppCore
import SwiftUI

@main
struct CaddieMenuApp: App {
    @StateObject private var model: AppModel
    private let locationMessage: String?
    private let mainWindow: CaddieWindowController?

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
            mainWindow = nil
        } else {
            locationMessage = nil
            mainWindow = CaddieWindowController(model: model)
            Task { @MainActor in model.start() }
        }
    }

    var body: some Scene {
        MenuBarExtra("Caddie", systemImage: menuSymbol) {
            if let locationMessage {
                BlockedLocationMenu(message: locationMessage)
            } else if let mainWindow {
                CaddieStatusMenu(model: model, openCaddie: mainWindow.show)
            }
        }
        .menuBarExtraStyle(.window)
    }

    private var menuSymbol: String {
        let presentation = SkillInventoryPresentation(snapshot: model.snapshot)
        if presentation.needsReview {
            return "exclamationmark.circle.fill"
        }
        if model.isRunningCycle { return "arrow.triangle.2.circlepath" }
        if model.updatesPaused { return "pause.circle" }
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
