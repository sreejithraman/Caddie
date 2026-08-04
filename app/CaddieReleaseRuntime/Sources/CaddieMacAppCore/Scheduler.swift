import Foundation

public enum ObservationEvent: Equatable, Sendable {
    case appStart
    case wake
    case registrationChanged
    case syncNow
    case filesChanged(subjectIDs: Set<String>)
    case watchRootsUncertain
}

public struct ScheduledCycle: Equatable, Sendable {
    public enum Mode: String, Equatable, Sendable {
        case observeOnly = "observe-only"
        case authorized = "authorized-user-reconciliation"
    }

    public let mode: Mode
    public let reason: String
    public let subjectIDs: [String]
    public let allObservedSources: Bool
    public let refreshProjects: Bool
}

/// A clock-free state machine. The app owns timers; this type owns only scheduling rules.
public struct CycleSchedulerState: Equatable, Sendable {
    public static let quietDelay: TimeInterval = 2
    public static let constantChangeLimit: TimeInterval = 30

    public private(set) var isRunning = false
    public private(set) var nextRunAt: Date?

    private var firstFileEventAt: Date?
    private var lastFileEventAt: Date?
    private var subjectIDs: Set<String> = []
    private var allObservedSources = false
    private var refreshProjects = false
    private var forceObserveOnly = false
    private var immediateRequested = false
    private var reason = "file-events"

    public init() {}

    @discardableResult
    public mutating func receive(_ event: ObservationEvent, at now: Date) -> Date? {
        switch event {
        case .appStart:
            requestImmediate(reason: "app-start", allSources: true, projects: true, observeOnly: false, now: now)
        case .wake:
            requestImmediate(reason: "wake", allSources: true, projects: true, observeOnly: false, now: now)
        case .registrationChanged:
            requestImmediate(reason: "registration-change", allSources: true, projects: false, observeOnly: false, now: now)
        case .syncNow:
            requestImmediate(reason: "sync-now", allSources: true, projects: true, observeOnly: false, now: now)
        case let .filesChanged(ids):
            subjectIDs.formUnion(ids)
            firstFileEventAt = firstFileEventAt ?? now
            lastFileEventAt = now
            reason = "file-events"
            let quiet = now.addingTimeInterval(Self.quietDelay)
            let forced = firstFileEventAt!.addingTimeInterval(Self.constantChangeLimit)
            let fileDeadline = min(quiet, forced)
            if !immediateRequested { nextRunAt = fileDeadline }
        case .watchRootsUncertain:
            requestImmediate(reason: "watch-roots-uncertain", allSources: true, projects: false, observeOnly: true, now: now)
        }
        return nextRunAt
    }

    public mutating func beginDueCycle(at now: Date, automaticUpdatesPaused: Bool) -> ScheduledCycle? {
        guard !isRunning, let nextRunAt, nextRunAt <= now else { return nil }
        let constantChange = firstFileEventAt.map { now >= $0.addingTimeInterval(Self.constantChangeLimit) } == true
            && lastFileEventAt.map { now < $0.addingTimeInterval(Self.quietDelay) } == true
        let mode: ScheduledCycle.Mode = automaticUpdatesPaused || forceObserveOnly || constantChange ? .observeOnly : .authorized
        let cycle = ScheduledCycle(
            mode: mode,
            reason: constantChange ? "constant-change" : reason,
            subjectIDs: subjectIDs.sorted(),
            allObservedSources: allObservedSources,
            refreshProjects: refreshProjects
        )
        isRunning = true
        clearPending()
        return cycle
    }

    /// Events received during a run remain queued. This returns their existing due time.
    public mutating func finishCycle() -> Date? {
        isRunning = false
        return nextRunAt
    }

    private mutating func requestImmediate(
        reason: String,
        allSources: Bool,
        projects: Bool,
        observeOnly: Bool,
        now: Date
    ) {
        self.reason = reason
        allObservedSources = allObservedSources || allSources
        refreshProjects = refreshProjects || projects
        forceObserveOnly = forceObserveOnly || observeOnly
        immediateRequested = true
        schedule(now)
    }

    private mutating func schedule(_ date: Date) {
        if let nextRunAt { self.nextRunAt = min(nextRunAt, date) }
        else { nextRunAt = date }
    }

    private mutating func clearPending() {
        nextRunAt = nil
        firstFileEventAt = nil
        lastFileEventAt = nil
        subjectIDs = []
        allObservedSources = false
        refreshProjects = false
        forceObserveOnly = false
        immediateRequested = false
        reason = "file-events"
    }
}

struct InspectionVerificationState: Equatable, Sendable {
    private(set) var pending = false

    mutating func beginCycle() -> Bool {
        let prior = pending
        pending = false
        return prior
    }

    mutating func finishCycle(changed: Bool) { pending = changed }
    mutating func failCycle(restoring prior: Bool) { pending = prior }

    mutating func consumeToolStateHint(snapshotChanged: Bool?) -> Bool {
        guard let snapshotChanged else { return true }
        guard snapshotChanged || pending else { return false }
        pending = false
        return true
    }
}
