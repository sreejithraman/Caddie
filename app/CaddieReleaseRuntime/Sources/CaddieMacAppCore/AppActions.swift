import AppKit
import Foundation
import UserNotifications

public enum AgentHandoffLink {
    public static func url(provider: AgentProvider, workFolder: String, prompt: String) throws -> URL {
        var parts = URLComponents()
        switch provider {
        case .codex:
            parts.scheme = "codex"
            parts.host = "threads"
            parts.path = "/new"
            parts.queryItems = [.init(name: "prompt", value: prompt), .init(name: "path", value: workFolder)]
        case .claude:
            parts.scheme = "claude"
            parts.host = "code"
            parts.path = "/new"
            parts.queryItems = [.init(name: "q", value: prompt), .init(name: "folder", value: workFolder)]
        }
        guard let url = parts.url else { throw AppActionFault.invalidHandoff }
        return url
    }
}

@MainActor
public protocol WorkspaceOpening {
    func open(_ url: URL) -> Bool
}

@MainActor
public struct SystemWorkspaceOpener: WorkspaceOpening {
    public init() {}
    public func open(_ url: URL) -> Bool { NSWorkspace.shared.open(url) }
}

public protocol NotificationDelivering: Sendable {
    func requestPermission() async throws -> Bool
    func deliver(id: String, title: String, body: String, attentionID: String?) async throws
}

public final class SystemNotificationDelivery: @unchecked Sendable, NotificationDelivering {
    private let delegate: AttentionNotificationDelegate
    @MainActor public convenience init() { self.init(router: AttentionPanelRouter.shared) }
    public init(router: any AttentionRouting) {
        delegate = AttentionNotificationDelegate(router: router)
        if Bundle.main.bundleURL.pathExtension == "app" {
            UNUserNotificationCenter.current().delegate = delegate
        }
    }
    public func requestPermission() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = delegate
        return try await center.requestAuthorization(options: [.alert])
    }
    public func deliver(id: String, title: String, body: String, attentionID: String?) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = nil
        var userInfo: [String: String] = ["effectId": id]
        if let attentionID { userInfo["attentionId"] = attentionID }
        content.userInfo = userInfo
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        let center = UNUserNotificationCenter.current()
        center.delegate = delegate
        try await center.add(request)
    }
}

@MainActor public protocol AttentionRouting: AnyObject {
    func openAttention(id: String)
}

@MainActor
public final class AttentionPanelRouter: AttentionRouting {
    public static let shared = AttentionPanelRouter()
    public private(set) var lastOpenedAttentionID: String?
    private var attention: [String: AppSnapshot.Attention] = [:]
    private var panel: NSPanel?

    public func update(_ snapshot: AppSnapshot) {
        attention = Dictionary(uniqueKeysWithValues: (snapshot.attention + snapshot.recentAttention).map { ($0.id, $0) })
    }

    public func openAttention(id: String) {
        lastOpenedAttentionID = id
        let item = attention[id]
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
            styleMask: [.titled, .closable], backing: .buffered, defer: false
        )
        panel.title = "Caddie Attention"
        let label = NSTextField(wrappingLabelWithString: [
            item?.code ?? "Attention",
            item?.condition ?? "Open Caddie to refresh this item.",
            "ID: \(id)",
        ].joined(separator: "\n\n"))
        label.frame = NSRect(x: 24, y: 24, width: 372, height: 156)
        panel.contentView?.addSubview(label)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        self.panel = panel
    }
}

final class AttentionNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private let router: any AttentionRouting
    init(router: any AttentionRouting) { self.router = router }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await routeDefaultAction(actionIdentifier: response.actionIdentifier, userInfo: response.notification.request.content.userInfo)
    }

    func routeDefaultAction(actionIdentifier: String, userInfo: [AnyHashable: Any]) async {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier,
              let id = userInfo["attentionId"] as? String, !id.isEmpty else { return }
        await router.openAttention(id: id)
    }
}

@MainActor
public final class NotificationPreferences: ObservableObject {
    @Published public private(set) var enabled: Bool
    private let defaults: UserDefaults
    private static let enabledKey = "notificationsEnabled"
    private static let attentionMutesKey = "notificationAttentionMutes"
    private static let sourceMutesKey = "notificationSourceMutes"
    private static let deliveredKey = "deliveredOutsideEffects"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Self.enabledKey)
    }

    public func setEnabled(_ value: Bool) { enabled = value; defaults.set(value, forKey: Self.enabledKey) }
    public func muteAttention(stableKey: String) { update(Self.attentionMutesKey) { $0.insert(stableKey) } }
    public func muteSource(_ sourceID: String) { update(Self.sourceMutesKey) { $0.insert(sourceID) } }
    public func unmuteAttention(stableKey: String) { update(Self.attentionMutesKey) { $0.remove(stableKey) } }
    public func unmuteSource(_ sourceID: String) { update(Self.sourceMutesKey) { $0.remove(sourceID) } }
    public func isMuted(_ item: AppSnapshot.Attention, sourceID: String? = nil) -> Bool {
        values(Self.attentionMutesKey).contains(item.stableKey)
            || values(Self.sourceMutesKey).contains(sourceID ?? item.subjectId)
    }
    public func reconcile(open attention: [AppSnapshot.Attention]) {
        let live = Set(attention.map(\.stableKey))
        update(Self.attentionMutesKey) { $0.formIntersection(live) }
    }
    public func wasDelivered(_ id: String) -> Bool { deliveredIDs.contains(id) }
    public func markDelivered(_ id: String) {
        var ids = deliveredIDs.filter { $0 != id }
        ids.append(id)
        defaults.set(Array(ids.suffix(200)), forKey: Self.deliveredKey)
    }

    private func values(_ key: String) -> Set<String> { Set(defaults.stringArray(forKey: key) ?? []) }
    private var deliveredIDs: [String] { defaults.stringArray(forKey: Self.deliveredKey) ?? [] }
    private func update(_ key: String, change: (inout Set<String>) -> Void) {
        var set = values(key); change(&set); defaults.set(set.sorted(), forKey: key)
    }
}

public enum AppActionFault: LocalizedError, Equatable {
    case invalidHandoff
    case missingPendingAction
    case missingOutsideEffect
    case notificationDenied

    public var errorDescription: String? {
        switch self {
        case .invalidHandoff: "Caddie could not build the Agent Handoff link."
        case .missingPendingAction: "Caddie did not receive the action it expected. Refresh and try again."
        case .missingOutsideEffect: "Caddie could not open this Agent Handoff. Refresh and try again."
        case .notificationDenied: "Notifications are off in System Settings."
        }
    }
}
