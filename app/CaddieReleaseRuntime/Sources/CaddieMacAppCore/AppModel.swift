import AppKit
import Foundation
import ServiceManagement

@MainActor
public final class AppModel: ObservableObject {
    @Published public private(set) var snapshot: AppSnapshot = .empty
    @Published public private(set) var isRunningCycle = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var loginItemStatus: SMAppService.Status
    @Published public private(set) var notificationsEnabled: Bool
    @Published public private(set) var lastAgentProvider: AgentProvider
    @Published public var automaticUpdatesPaused: Bool {
        didSet { defaults.set(automaticUpdatesPaused, forKey: Self.pauseKey) }
    }

    public var menuSnapshot: AppSnapshot { snapshot }
    public var updatesPaused: Bool { automaticUpdatesPaused || snapshot.pause.active }

    private static let pauseKey = "automaticUpdatesPaused"
    private static let providerKey = "lastAgentProvider"
    private let client: any ToolCalling
    private let defaults: UserDefaults
    private let loginItem: any LoginItemManaging
    private let notifications: any NotificationDelivering
    private let notificationPreferences: NotificationPreferences
    private let workspace: any WorkspaceOpening
    private let toolStateRoot: URL
    private var scheduler = CycleSchedulerState()
    private var scheduledWork: DispatchWorkItem?
    private var watcher: FSEventWatcher?
    private var wakeObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?
    private var started = false
    private var effectDrainTask: Task<Void, Never>?
    private var effectDrainDirty = false
    private var toolStateRefreshTask: Task<Void, Never>?
    private var toolStateRefreshDirty = false
    private var toolStateRefreshSubjectIDs: Set<String> = []
    private var verification = InspectionVerificationState()
    private var notificationToggleRevision = 0
    private var handoffsInFlight: Set<String> = []
    private var openedHandoffs: [String: AppSnapshot.OutsideEffect] = [:]

    public init(
        client: any ToolCalling,
        defaults: UserDefaults = .standard,
        loginItem: any LoginItemManaging = MainAppLoginItem(),
        notifications: any NotificationDelivering = SystemNotificationDelivery(),
        workspace: any WorkspaceOpening = SystemWorkspaceOpener(),
        toolStateRoot: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agents/.caddie", isDirectory: true),
        initialSnapshot: AppSnapshot = .empty
    ) {
        self.client = client
        self.defaults = defaults
        self.loginItem = loginItem
        self.notifications = notifications
        self.workspace = workspace
        self.toolStateRoot = toolStateRoot
        notificationPreferences = NotificationPreferences(defaults: defaults)
        notificationsEnabled = notificationPreferences.enabled
        lastAgentProvider = AgentProvider(rawValue: defaults.string(forKey: Self.providerKey) ?? "") ?? .codex
        snapshot = initialSnapshot
        AttentionPanelRouter.shared.update(initialSnapshot)
        automaticUpdatesPaused = defaults.bool(forKey: Self.pauseKey)
        loginItemStatus = loginItem.status
    }

    public func start() {
        guard !started else { return }
        started = true
        watcher = FSEventWatcher(
            toolStateRoot: toolStateRoot,
            onObservation: { [weak self] observation in
                Task { @MainActor in
                    guard let self else { return }
                    if observation.rootsUncertain { self.receive(.watchRootsUncertain) }
                    else if observation.containsOnlyToolStateChanges {
                        self.scheduleToolStateRefresh(subjectIDs: observation.watchIDs)
                    }
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

    @discardableResult
    public func prepareForAppRemoval() -> Bool {
        if loginItem.status == .notRegistered || loginItem.status == .notFound { return true }
        do {
            try loginItem.setEnabled(false)
            loginItemStatus = loginItem.status
            return true
        } catch {
            lastError = "Caddie could not turn off Start at login. \(readable(error))"
            return false
        }
    }

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

    public func setNotificationsEnabled(_ enabled: Bool) async {
        notificationToggleRevision += 1
        let revision = notificationToggleRevision
        if !enabled {
            notificationPreferences.setEnabled(false)
            notificationsEnabled = false
            effectDrainDirty = false
            effectDrainTask?.cancel()
            return
        }
        do {
            let allowed = try await notifications.requestPermission()
            guard revision == notificationToggleRevision else { return }
            guard allowed else { throw AppActionFault.notificationDenied }
            notificationPreferences.setEnabled(true)
            notificationsEnabled = true
            scheduleEffectDrain()
        } catch {
            guard revision == notificationToggleRevision else { return }
            lastError = readable(error)
        }
    }

    public func setAuthorization(selectionID: String, enabled: Bool) async {
        await perform(enabled ? .authorize(selectionID: selectionID) : .revokeAuthorization(selectionID: selectionID))
    }

    public func update(selectionID: String) async { await perform(.update(selectionID: selectionID)) }
    public func retry(attentionID: String) async { await perform(.retry(attentionID: attentionID)) }

    public func invoke(actionID: String, extendedTimeout: Bool = false) async {
        do { accept(try await client.invoke(actionID: actionID, extendedTimeout: extendedTimeout)); lastError = nil }
        catch { lastError = readable(error) }
    }

    public func mute(_ item: AppSnapshot.Attention) { notificationPreferences.muteAttention(stableKey: item.stableKey) }
    public func unmute(_ item: AppSnapshot.Attention) { notificationPreferences.unmuteAttention(stableKey: item.stableKey) }
    public func muteSource(_ sourceID: String) { notificationPreferences.muteSource(sourceID) }
    public func unmuteSource(_ sourceID: String) { notificationPreferences.unmuteSource(sourceID) }
    public func isMuted(_ item: AppSnapshot.Attention) -> Bool {
        notificationPreferences.isMuted(item, sourceID: sourceID(for: item))
    }

    public func canHandoff(_ item: AppSnapshot.Attention) -> Bool {
        guard item.state == "open",
              let skill = snapshot.userSkills.first(where: { $0.id == item.subjectId }),
              let checkout = skill.sourceCheckout,
              let source = snapshot.sources.first(where: { $0.id == skill.sourceId }),
              source.checkout == checkout,
              let branch = skill.branch, !branch.isEmpty,
              let commit = skill.commit, (40...64).contains(commit.count),
              commit.allSatisfy({ $0.isHexDigit }) else { return false }
        return true
    }

    public func handoff(attentionID: String, provider: AgentProvider) async {
        let handoffKey = "\(attentionID)\u{0}\(provider.rawValue)"
        guard handoffsInFlight.insert(handoffKey).inserted else { return }
        defer { handoffsInFlight.remove(handoffKey) }
        lastAgentProvider = provider
        defaults.set(provider.rawValue, forKey: Self.providerKey)
        do {
            if let prior = openedHandoffs[handoffKey],
               let folder = prior.workFolder, let prompt = prior.prompt {
                let url = try AgentHandoffLink.url(provider: provider, workFolder: folder, prompt: prompt)
                guard workspace.open(url) else { throw AppActionFault.missingOutsideEffect }
                lastError = nil
                return
            }
            var current = snapshot
            var effect = matchingHandoffEffect(in: current, attentionID: attentionID, provider: provider)
            if effect == nil {
                var action = current.pendingActions.first(where: {
                    $0.intent.type == "agent-handoff" && $0.intent.attentionId == attentionID
                        && $0.intent.provider == provider.rawValue
                })
                if action == nil {
                    current = try await client.request(.handoff(attentionID: attentionID, provider: provider))
                    accept(current)
                    action = current.pendingActions.first(where: {
                        $0.intent.type == "agent-handoff" && $0.intent.attentionId == attentionID
                            && $0.intent.provider == provider.rawValue
                    })
                }
                guard let action else { throw AppActionFault.missingPendingAction }
                current = try await client.invoke(actionID: action.id, extendedTimeout: false)
                accept(current)
                effect = matchingHandoffEffect(in: current, attentionID: attentionID, provider: provider)
            }
            guard let effect, let folder = effect.workFolder, let prompt = effect.prompt else {
                throw AppActionFault.missingOutsideEffect
            }
            let url = try AgentHandoffLink.url(provider: provider, workFolder: folder, prompt: prompt)
            let outcome: AppEffectOutcome
            if effect.outcome == "opened" {
                outcome = workspace.open(url) ? .opened : .failed
            } else if notificationPreferences.wasDelivered(effect.id) {
                outcome = .opened
            } else if workspace.open(url) {
                notificationPreferences.markDelivered(effect.id)
                outcome = .opened
            } else {
                outcome = .failed
            }
            accept(try await client.report(effectID: effect.id, outcome: outcome))
            if outcome == .opened { openedHandoffs[handoffKey] = effect }
            lastError = nil
        } catch { lastError = readable(error) }
    }

    private func matchingHandoffEffect(
        in snapshot: AppSnapshot, attentionID: String, provider: AgentProvider
    ) -> AppSnapshot.OutsideEffect? {
        snapshot.outsideEffects.first {
            $0.kind == "agent-handoff" && $0.attentionId == attentionID && $0.provider == provider.rawValue
        }
    }

    private func perform(_ intent: AppActionIntent) async {
        do {
            let requested = try await client.request(intent)
            if intent.completesOnRequest {
                accept(requested)
                lastError = nil
                return
            }
            guard let action = requested.pendingActions.first(where: { intent.matches($0.intent) }) else {
                throw AppActionFault.missingPendingAction
            }
            accept(try await client.invoke(actionID: action.id, extendedTimeout: false))
            lastError = nil
        } catch { lastError = readable(error) }
    }

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
        let priorVerification = verification.beginCycle()
        do {
            let prior = snapshot
            let next = try await client.cycle(cycle)
            verification.finishCycle(changed: next.hasInspectionRelevantChanges(comparedTo: prior))
            accept(next)
            lastError = nil
        } catch {
            verification.failCycle(restoring: priorVerification)
            lastError = readable(error)
        }
        isRunningCycle = false
        schedule(at: scheduler.finishCycle())
        startToolStateRefreshIfNeeded()
    }

    private func accept(_ next: AppSnapshot) {
        lastError = nil
        install(next)
        scheduleEffectDrain()
    }

    private func scheduleToolStateRefresh(subjectIDs: Set<String>) {
        toolStateRefreshDirty = true
        toolStateRefreshSubjectIDs.formUnion(subjectIDs)
        startToolStateRefreshIfNeeded()
    }

    private func startToolStateRefreshIfNeeded() {
        guard !isRunningCycle, toolStateRefreshDirty, toolStateRefreshTask == nil else { return }
        toolStateRefreshTask = Task { [weak self] in await self?.refreshToolState() }
    }

    private func refreshToolState() async {
        while !Task.isCancelled && toolStateRefreshDirty {
            toolStateRefreshDirty = false
            let subjectIDs = toolStateRefreshSubjectIDs
            toolStateRefreshSubjectIDs = []
            do {
                let current = try await client.status()
                let changed = current != snapshot
                if changed { accept(current) }
                if verification.consumeToolStateHint(snapshotChanged: changed) {
                    receive(.filesChanged(subjectIDs: subjectIDs))
                }
            } catch {
                lastError = readable(error)
                if verification.consumeToolStateHint(snapshotChanged: nil) {
                    receive(.filesChanged(subjectIDs: subjectIDs))
                }
            }
        }
        toolStateRefreshTask = nil
        startToolStateRefreshIfNeeded()
    }

    private func install(_ next: AppSnapshot) {
        snapshot = next
        watcher?.replaceWatches(next.watchSet)
        notificationPreferences.reconcile(open: next.attention)
        AttentionPanelRouter.shared.update(next)
    }

    private func scheduleEffectDrain() {
        guard notificationsEnabled else { return }
        effectDrainDirty = true
        guard effectDrainTask == nil else { return }
        effectDrainTask = Task { [weak self] in await self?.drainEffects() }
    }

    private func drainEffects() async {
        while !Task.isCancelled && notificationsEnabled && effectDrainDirty {
            effectDrainDirty = false
            guard let (effect, item) = nextNotification() else { continue }
            let outcome: AppEffectOutcome
            if isMuted(item) { outcome = .unavailable }
            else if notificationPreferences.wasDelivered(effect.id) { outcome = .delivered }
            else {
                do {
                    try await notifications.deliver(
                        id: effect.id,
                        title: item.state == "resolved" ? "Caddie resolved an item" : "Caddie needs attention",
                        body: item.code,
                        attentionID: item.id
                    )
                    notificationPreferences.markDelivered(effect.id)
                    outcome = .delivered
                } catch { outcome = .failed }
            }
            guard !Task.isCancelled, notificationsEnabled else { break }
            do {
                install(try await client.report(effectID: effect.id, outcome: outcome))
                effectDrainDirty = true
            } catch { lastError = readable(error) }
        }
        effectDrainTask = nil
        if effectDrainDirty { scheduleEffectDrain() }
    }

    private func nextNotification() -> (AppSnapshot.OutsideEffect, AppSnapshot.Attention)? {
        for effect in snapshot.outsideEffects where effect.kind == "notification" && effect.outcome == nil {
            guard let id = effect.attentionId,
                  let item = (snapshot.attention + snapshot.recentAttention).first(where: { $0.id == id }) else { continue }
            return (effect, item)
        }
        return nil
    }

    private func readable(_ error: Error) -> String {
        if let tool = error as? ToolResponse.ErrorBody { return tool.message }
        return error.localizedDescription
    }

    private func sourceID(for item: AppSnapshot.Attention) -> String? {
        if snapshot.sources.contains(where: { $0.id == item.subjectId }) { return item.subjectId }
        return snapshot.userSkills.first(where: { $0.id == item.subjectId })?.sourceId
    }
}
