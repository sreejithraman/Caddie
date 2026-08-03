import ServiceManagement

@MainActor
public protocol LoginItemManaging {
    var status: SMAppService.Status { get }
    func setEnabled(_ enabled: Bool) throws
    func openSystemSettings()
}

@MainActor
public struct MainAppLoginItem: LoginItemManaging {
    public init() {}

    public var status: SMAppService.Status { SMAppService.mainApp.status }

    public func setEnabled(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() }
        else { try SMAppService.mainApp.unregister() }
    }

    public func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
