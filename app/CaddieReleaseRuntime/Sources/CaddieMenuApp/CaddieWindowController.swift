import AppKit
import CaddieMacAppCore
import SwiftUI

@MainActor
final class CaddieWindowController: NSWindowController {
    init(model: AppModel) {
        let hostingController = NSHostingController(rootView: CaddieMainWindow(model: model))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_000, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Caddie"
        window.contentViewController = hostingController
        window.minSize = NSSize(width: 780, height: 520)
        window.setFrameAutosaveName("CaddieMainWindow")
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func show() {
        window?.deminiaturize(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }
}
