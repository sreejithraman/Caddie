import CaddieMacAppCore
import SwiftUI

@main
struct CaddieMenuApp: App {
    @StateObject private var model: AppModel
    @State private var isMenuBarInserted = true
    private let locationMessage: String?

    init() {
        let channel = CaddieBuildChannel(bundleIdentifier: Bundle.main.bundleIdentifier)
        let supportRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(channel.applicationSupportFolder, isDirectory: true)
        let environment = channel.toolEnvironment(base: ProcessInfo.processInfo.environment, supportRoot: supportRoot)
        let toolHome = URL(fileURLWithPath: environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path)
        let preview = PreviewLaunch(arguments: ProcessInfo.processInfo.arguments, channel: channel)
        let previewResult: Result<AppSnapshot, Error>? = preview.directory.map { directory in
            Result { try PreviewSnapshotLoader().load(from: directory) }
        }
        let initialSnapshot = try? previewResult?.get()
        let initialError: String?
        if case .failure(let error) = previewResult {
            initialError = error.localizedDescription
        } else {
            initialError = preview.error
        }
        let client: any ToolCalling = preview.isRequested
            ? PreviewDisabledToolClient()
            : ToolLaunchClient(supportRoot: supportRoot, environment: environment)
        let notifications: any NotificationDelivering = preview.isRequested
            ? PreviewDisabledNotifications()
            : SystemNotificationDelivery()
        let model = AppModel(
            client: client,
            notifications: notifications,
            toolStateRoot: toolHome.appendingPathComponent(".agents/.caddie", isDirectory: true),
            mode: preview.isRequested ? .preview : .live,
            initialError: initialError,
            initialSnapshot: initialSnapshot ?? .empty
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
        MenuBarExtra(isInserted: menuBarInsertion) {
            CaddieMenuContent(model: model, locationMessage: locationMessage)
        } label: {
            CaddieMenuBarLabel(symbol: menuSymbol)
        }
        .menuBarExtraStyle(.window)

        Window("Caddie", id: "main") {
            if let locationMessage {
                BlockedLocationView(message: locationMessage)
            } else {
                CaddieMainWindow(model: model)
            }
        }
        .defaultSize(width: 1_000, height: 700)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))
    }

    private var menuSymbol: String {
        CaddieAppStatusPresentation(CaddieAppStatus(
            snapshot: model.snapshot,
            isRunningCycle: model.isRunningCycle,
            updatesPaused: model.updatesPaused
        )).menuBarSymbol
    }

    private var menuBarInsertion: Binding<Bool> {
        Binding(
            get: { isMenuBarInserted },
            set: { inserted in
                isMenuBarInserted = inserted
                if !inserted { NSApplication.shared.terminate(nil) }
            }
        )
    }
}

private struct PreviewLaunch {
    let isRequested: Bool
    let directory: URL?
    let error: String?

    init(arguments: [String], channel: CaddieBuildChannel) {
        guard let index = arguments.firstIndex(of: "--preview-snapshot") else {
            isRequested = false
            directory = nil
            error = nil
            return
        }
        isRequested = true
        guard channel == .development else {
            directory = nil
            error = "Read-only preview is available only in development builds."
            return
        }
        let valueIndex = arguments.index(after: index)
        guard arguments.indices.contains(valueIndex), !arguments[valueIndex].isEmpty else {
            directory = nil
            error = "The preview snapshot folder is missing."
            return
        }
        directory = URL(fileURLWithPath: arguments[valueIndex], isDirectory: true)
        error = nil
    }
}

private struct PreviewDisabledToolClient: ToolCalling {
    func status() async throws -> AppSnapshot { throw PreviewToolFault.readOnly }
    func cycle(_ cycle: ScheduledCycle) async throws -> AppSnapshot { throw PreviewToolFault.readOnly }
    func request(_ intent: AppActionIntent) async throws -> AppSnapshot { throw PreviewToolFault.readOnly }
    func invoke(actionID: String, extendedTimeout: Bool) async throws -> AppSnapshot { throw PreviewToolFault.readOnly }
    func report(effectID: String, outcome: AppEffectOutcome) async throws -> AppSnapshot { throw PreviewToolFault.readOnly }
    func requestResume() async throws -> AppSnapshot { throw PreviewToolFault.readOnly }

    private enum PreviewToolFault: Error { case readOnly }
}

private struct PreviewDisabledNotifications: NotificationDelivering {
    func requestPermission() async throws -> Bool { false }
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws {}
}

private struct CaddieMenuBarLabel: View {
    let symbol: String
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Label("Caddie", systemImage: symbol)
            .labelStyle(.iconOnly)
            #if DEBUG
            .task {
                if ProcessInfo.processInfo.arguments.contains("--show-main-window") {
                    openWindow(id: "main")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            }
            #endif
    }
}

private struct CaddieMenuContent: View {
    @ObservedObject var model: AppModel
    let locationMessage: String?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if let locationMessage {
                BlockedLocationMenu(message: locationMessage)
            } else {
                CaddieStatusMenu(model: model) {
                    openWindow(id: "main")
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            }
        }
    }
}

private struct BlockedLocationView: View {
    let message: String

    var body: some View {
        Group {
            if #available(macOS 14.0, *) {
                ContentUnavailableView(
                    "Move Caddie",
                    systemImage: "folder.badge.questionmark",
                    description: Text(message)
                )
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "folder.badge.questionmark").font(.largeTitle)
                    Text("Move Caddie").font(.headline)
                    Text(message).foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                .padding()
            }
        }
        .frame(minWidth: 520, minHeight: 320)
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
