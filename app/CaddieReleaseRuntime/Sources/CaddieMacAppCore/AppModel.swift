import AppKit
import Foundation
import ServiceManagement

@MainActor
public final class AppModel: ObservableObject {
    @Published public private(set) var snapshot: AppSnapshot = .empty
    @Published public private(set) var isRunningCycle = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var loginItemStatus: SMAppService.Status
    @Published public var automaticUpdatesPaused: Bool {
        didSet { defaults.set(automaticUpdatesPaused, forKey: Self.pauseKey) }
    }

    public var menuSnapshot: AppSnapshot { snapshot }
    public var updatesPaused: Bool { automaticUpdatesPaused || snapshot.pause.active }

    private static let pauseKey = "automaticUpdatesPaused"
    private let client: any ToolCalling
    private let defaults: UserDefaults
    private let loginItem: any LoginItemManaging
    private var scheduler = CycleSchedulerState()
    private var scheduledWork: DispatchWorkItem?
    private var watcher: FSEventWatcher?
    private var wakeObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?
    private var started = false

    public init(
        client: any ToolCalling,
        defaults: UserDefaults = .standard,
        loginItem: any LoginItemManaging = MainAppLoginItem(),
        initialSnapshot: AppSnapshot = .empty
    ) {
        self.client = client
        self.defaults = defaults
        self.loginItem = loginItem
        snapshot = initialSnapshot
        automaticUpdatesPaused = defaults.bool(forKey: Self.pauseKey)
        loginItemStatus = loginItem.status
    }

    public func start() {
        guard !started else { return }
        started = true
        watcher = FSEventWatcher(
            onObservation: { [weak self] observation in
                Task { @MainActor in
                    guard let self else { return }
                    if observation.rootsUncertain { self.receive(.watchRootsUncertain) }
                    else if !observation.watchIDs.isEmpty { self.receive(.filesChanged(subjectIDs: observation.watchIDs)) }
                }
            },
            onFault: { [weak self] message in Task { @MainActor in self?.lastError = message } }
        )
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.refreshLoginStatus()
                self?.receive(.wake)
            }
        }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.refreshLoginStatus() } }
        Task {
            do {
                let cached = try await client.status()
                accept(cached)
            } catch { lastError = readable(error) }
            receive(.appStart)
        }
    }

    public func syncNow() { receive(.syncNow) }

    public func toggleAutomaticUpdates() async {
        if !updatesPaused {
            automaticUpdatesPaused = true
            return
        }
        automaticUpdatesPaused = false
        if snapshot.pause.active {
            do {
                accept(try await client.requestResume())
                lastError = nil
            } catch {
                lastError = "Caddie is still safety paused. \(readable(error))"
                return
            }
        }
        receive(.registrationChanged)
    }

    public func setStartAtLogin(_ enabled: Bool) {
        guard snapshot.state == "ready" else {
            lastError = "Finish Caddie setup before turning on Start at login."
            return
        }
        do {
            try loginItem.setEnabled(enabled)
            loginItemStatus = loginItem.status
            if loginItemStatus == .requiresApproval { loginItem.openSystemSettings() }
        } catch { lastError = readable(error) }
    }

    public func openLoginItemSettings() { loginItem.openSystemSettings() }

    public func refreshLoginStatus() { loginItemStatus = loginItem.status }

    public func grantAccess(to exactPath: String) {
        guard let selected = FolderAccess.chooseFolder(for: exactPath) else { return }
        guard selected.standardizedFileURL.path == URL(fileURLWithPath: exactPath).standardizedFileURL.path else {
            lastError = "Choose the exact folder Caddie could not read."
            return
        }
        receive(.registrationChanged)
    }

    public func clearError() { lastError = nil }

    private func receive(_ event: ObservationEvent) {
        let date = scheduler.receive(event, at: Date())
        if !scheduler.isRunning { schedule(at: date) }
    }

    private func schedule(at date: Date?) {
        scheduledWork?.cancel()
        guard let date else { return }
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in await self?.runDueCycle() }
        }
        scheduledWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, date.timeIntervalSinceNow), execute: work)
    }

    private func runDueCycle() async {
        guard let cycle = scheduler.beginDueCycle(at: Date(), automaticUpdatesPaused: automaticUpdatesPaused) else {
            schedule(at: scheduler.nextRunAt)
            return
        }
        isRunningCycle = true
        do {
            accept(try await client.cycle(cycle))
            lastError = nil
        } catch { lastError = readable(error) }
        isRunningCycle = false
        schedule(at: scheduler.finishCycle())
    }

    private func accept(_ next: AppSnapshot) {
        snapshot = next
        watcher?.replaceWatches(next.watchSet)
    }

    private func readable(_ error: Error) -> String {
        if let tool = error as? ToolResponse.ErrorBody { return tool.message }
        return error.localizedDescription
    }
}
