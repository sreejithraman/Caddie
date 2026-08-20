import AppKit
import Foundation

@MainActor
public enum FolderAccess {
    public static func chooseFolder(for deniedPath: String? = nil) -> URL? {
        let panel = NSOpenPanel()
        panel.title = deniedPath.map { "Grant Caddie Access to \($0)" } ?? "Add a Skill Source"
        panel.message = "Choose the exact source folder. Caddie does not need Full Disk Access."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        if let deniedPath { panel.directoryURL = URL(fileURLWithPath: deniedPath) }
        return panel.runModal() == .OK ? panel.url : nil
    }
}
