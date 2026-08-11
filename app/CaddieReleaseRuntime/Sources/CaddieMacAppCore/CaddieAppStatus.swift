public enum CaddieAppStatus: Equatable, Sendable {
    case checking
    case paused
    case waiting
    case needsReview
    case updatesReady
    case current

    public init(snapshot: AppSnapshot, isRunningCycle: Bool, updatesPaused: Bool) {
        if isRunningCycle {
            self = .checking
        } else if updatesPaused {
            self = .paused
        } else if snapshot.freshness.checkedAt == nil {
            self = .waiting
        } else if snapshot.summary.attention > 0
            || snapshot.inventoryProjects.contains(where: { $0.status == "attention" })
            || snapshot.inventorySkills.contains(where: \.needsStandaloneInventoryReview) {
            self = .needsReview
        } else if !snapshot.readyWork.isEmpty {
            self = .updatesReady
        } else {
            self = .current
        }
    }
}
